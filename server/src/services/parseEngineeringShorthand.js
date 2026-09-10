// server/src/services/parseEngineeringShorthand.js
//
// Reads the compressed shorthand real customers actually send.
//
// A live enquiry from the level-gauge family looked like this, as one line:
//
//   LG,FINISHED,TUBLR,CC-1450MM,PC-1"ASA 150#MS+POWDER COAT,WTD PTS-MS+POWDER
//   COATED,GLND-MS,GLS-19MMOD PKG-PTFE,ISO VLV-2 NO,ATO SHT OFF BL CHK VLV OFST
//   TRM-SS316,SCL-AL,LC-5MM,DRN&VNT-1/2"NPT VLV&PLUG+POWER COATED,10KG,100 DEGGC
//
// parseEnquiryText.js read NOTHING out of that — no range, no temperature, no
// area, no output — because its patterns expect prose ("0 to 10 bar", "100 °C").
// With zero evidence the scorer left every candidate at its 0.5 starting point
// and six products tied at 50%.
//
// Yet almost every requirement is in there and is perfectly machine-readable:
// 10 kg/cm² design pressure, 100 °C, 1" ASA 150# process connection, 1450 mm
// centre-to-centre, PTFE packing, SS316 trim, mild steel body. These are CODES,
// not language — the same argument as parseInstrumentTag.js. Reading them with
// regex and a dictionary is exact, instant, free, and works when the model is
// down. It also gives the LLM better material when it is up.
//
// Deliberately conservative: an abbreviation is only reported when it is
// unambiguous. Anything unrecognised is left for the model rather than guessed.

// --- abbreviation dictionary -------------------------------------------------
// Only entries that are unambiguous in an instrument enquiry. "PC" is process
// connection here, never "personal computer"; "CC" is centre-to-centre.
const MATERIALS = {
  SS316L: 'SS316L', SS316: 'SS316', SS304L: 'SS304L', SS304: 'SS304',
  'SS 316': 'SS316', 'SS 304': 'SS304',
  MS: 'Mild steel', CS: 'Carbon steel', AL: 'Aluminium',
  PTFE: 'PTFE', PP: 'Polypropylene', PVC: 'PVC',
  MONEL: 'Monel', HASTELLOY: 'Hastelloy', 'HAST C': 'Hastelloy C',
  INCONEL: 'Inconel', TITANIUM: 'Titanium', BRASS: 'Brass',
  GLASS: 'Glass', MICA: 'Mica', NEOPRENE: 'Neoprene', VITON: 'Viton',
};

// Component prefix -> the human label it carries.
const COMPONENT_PREFIXES = {
  PC: 'Process connection',
  CC: 'Centre to centre',
  TRM: 'Trim',
  PKG: 'Packing',
  SCL: 'Scale',
  GLND: 'Gland',
  GLS: 'Glass',
  LC: 'Level column',
  'DRN&VNT': 'Drain & vent',
  DRN: 'Drain',
  VNT: 'Vent',
  HARDWARE: 'Hardware',
  BODY: 'Body',
  COVER: 'Cover',
  FLG: 'Flange',
  SHT: 'Sheet',
};

// Standalone tokens that describe the instrument itself.
const TYPE_TOKENS = {
  TUBLR: 'Tubular', TUBULAR: 'Tubular',
  RFLX: 'Reflex', REFLEX: 'Reflex',
  TRNSP: 'Transparent', TRANSPARENT: 'Transparent',
  MAG: 'Magnetic', MAGNETIC: 'Magnetic',
  BICOLOUR: 'Bi-colour', 'BI-COLOUR': 'Bi-colour', 'BI COLOR': 'Bi-colour',
  WTD: 'Welded', WELDED: 'Welded',
  FINISHED: 'Finished',
};

const FITTING_TOKENS = {
  'ISO VLV': 'Isolation valve',
  'CHK VLV': 'Check valve',
  'SHT OFF': 'Shut-off',
  'BL CHK': 'Ball check',
  ATO: 'Air to open',
  ATC: 'Air to close',
  OFST: 'Offset',
  'VLV&PLUG': 'Valve and plug',
};

// --- unit patterns -----------------------------------------------------------
// Written to tolerate the typos real enquiries contain: "100 DEGGC" is a real
// value from a real customer sheet, and a strict /DEG ?C/ would have missed it.
const PRESSURE_KG = /\b(\d+(?:\.\d+)?)\s*KG(?:\s*\/?\s*(?:CM2|CM²|SQ\.?\s*CM))?\b/i;
const PRESSURE_BAR = /\b(\d+(?:\.\d+)?)\s*BAR(?:G|A)?\b/i;
const PRESSURE_PSI = /\b(\d+(?:\.\d+)?)\s*PSI(?:G|A)?\b/i;
// The leading boundary is a lookbehind, NOT \b.
//
// \b before an optional minus sign silently drops the minus: in "-40 DEG C"
// there is no word boundary at index 0 (the string starts with a non-word
// character), so the match began at the "4" and the parser reported +40 °C for
// a cryogenic requirement. That is a sign error in a stated customer
// specification, and it would have compared a -40 °C requirement against a
// product rated from 0 °C and called it satisfied.
//
// (?<![\w.]) instead means "not preceded by a word character or a decimal
// point", which excludes "T40 DEG C" and "1.40 DEG C" while allowing a leading
// minus at the start of a string, after a space, or after a comma.
const TEMPERATURE = /(?<![\w.])(-?\d+(?:\.\d+)?)\s*DEG+\.?\s*C\b|(?<![\w.])(-?\d+(?:\.\d+)?)\s*°\s*C\b/i;
// (A bare LENGTH_MM pattern lived here and was never used — every length in
// these enquiries arrives prefixed, CC-1450MM or LC-5MM, and is read by the
// component-prefix sweep below. An unprefixed millimetre value is too
// ambiguous to attach to any particular attribute, so it is left for the model.)
// 1"NPT, 1/2" NPT, 3/4"BSP, 1" ASA 150#, 2" #150 RF
const CONNECTION = /\b(\d+(?:\s*\/\s*\d+)?)\s*"?\s*(NPT|BSPT|BSP|ASA|ANSI|DIN|JIS|SW|RF|FF)\b/i;
const PRESSURE_CLASS = /\b(?:#\s*(\d{2,4})|(\d{2,4})\s*#)\b/;

function pushAttr(list, seen, label, value, source) {
  const key = label.toLowerCase();
  if (!value || seen.has(key)) return;
  seen.add(key);
  list.push({ label, value: String(value).trim(), source });
}

/**
 * @param {string} text raw enquiry text (any format; shorthand or prose)
 * @returns {{attributes: Array<{label,value,source}>, designPressure: object|null,
 *            tempMax: number|null, connection: string|null, materials: string[],
 *            instrumentStyle: string|null}}
 */
function parseEngineeringShorthand(text) {
  const raw = String(text || '');
  const upper = raw.toUpperCase();
  const attributes = [];
  const seen = new Set();
  const materials = [];

  // --- design pressure -------------------------------------------------------
  let designPressure = null;
  let m;
  if ((m = PRESSURE_KG.exec(upper))) {
    designPressure = { value: parseFloat(m[1]), unit: 'kg/cm²' };
  } else if ((m = PRESSURE_BAR.exec(upper))) {
    designPressure = { value: parseFloat(m[1]), unit: 'bar' };
  } else if ((m = PRESSURE_PSI.exec(upper))) {
    designPressure = { value: parseFloat(m[1]), unit: 'psi' };
  }
  if (designPressure) {
    pushAttr(attributes, seen, 'Design pressure', `${designPressure.value} ${designPressure.unit}`, 'shorthand');
  }

  // --- temperature -----------------------------------------------------------
  let tempMax = null;
  if ((m = TEMPERATURE.exec(upper))) {
    tempMax = parseFloat(m[1] ?? m[2]);
    pushAttr(attributes, seen, 'Design temperature', `${tempMax} °C`, 'shorthand');
  }

  // --- process connection ----------------------------------------------------
  let connection = null;
  if ((m = CONNECTION.exec(upper))) {
    const size = m[1].replace(/\s+/g, '');
    const std = m[2].toUpperCase();
    connection = `${size}" ${std}`;
    const cls = PRESSURE_CLASS.exec(upper);
    if (cls) connection += ` ${cls[1] || cls[2]}#`;
    pushAttr(attributes, seen, 'Process connection', connection, 'shorthand');
  }

  // --- centre-to-centre, normalised, BEFORE the generic sweep so this value
  // --- wins the dedupe rather than the raw "1450MM" the sweep would produce.
  const ccMatch = /\bCC\s*[-:]\s*(\d+(?:\.\d+)?)\s*MM\b/i.exec(upper);
  if (ccMatch) pushAttr(attributes, seen, 'Centre to centre', `${parseFloat(ccMatch[1])} mm`, 'shorthand');

  // --- component-prefixed values: PC-…, TRM-SS316, PKG-PTFE ------------------
  // One pass over "PREFIX-VALUE" pairs; the value runs to the next comma or the
  // next known prefix, so "TRM-SS316,SCL-AL" yields two attributes, not one.
  const prefixAlternation = Object.keys(COMPONENT_PREFIXES)
    .sort((a, b) => b.length - a.length)      // longest first: DRN&VNT before DRN
    .map((p) => p.replace(/[&]/g, '\\&'))
    .join('|');
  // The value ends at a comma OR at the next known prefix. Without the second
  // stop, "GLS-19MMOD PKG-PTFE" reads as one field whose value is
  // "19MMOD PKG-PTFE" and the PTFE packing is lost.
  const pairRe = new RegExp(`\\b(${prefixAlternation})\\s*[-:]\\s*(.+?)(?=,|\\s+(?:${prefixAlternation})\\s*[-:]|$)`, 'gi');
  let pair;
  while ((pair = pairRe.exec(upper)) !== null) {
    const label = COMPONENT_PREFIXES[pair[1].toUpperCase()];
    const value = pair[2].trim().replace(/\s+(?:AND|WITH|\+)\s*$/i, '').trim();
    if (label && value) pushAttr(attributes, seen, label, value, 'shorthand');
  }

  // --- materials -------------------------------------------------------------
  for (const [token, label] of Object.entries(MATERIALS)) {
    const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(upper) && !materials.includes(label)) materials.push(label);
  }
  if (materials.length) {
    pushAttr(attributes, seen, 'Materials mentioned', materials.join(', '), 'shorthand');
  }

  // --- instrument style ------------------------------------------------------
  let instrumentStyle = null;
  for (const [token, label] of Object.entries(TYPE_TOKENS)) {
    const re = new RegExp(`\\b${token.replace(/[&]/g, '\\&')}\\b`, 'i');
    if (re.test(upper)) {
      if (!instrumentStyle && !/^(Finished|Welded)$/.test(label)) instrumentStyle = label;
      pushAttr(attributes, seen, `Style: ${label}`, label, 'shorthand');
    }
  }

  // --- fittings and accessories ---------------------------------------------
  const fittings = [];
  for (const [token, label] of Object.entries(FITTING_TOKENS)) {
    const re = new RegExp(`\\b${token.replace(/[&]/g, '\\&')}\\b`, 'i');
    if (re.test(upper)) fittings.push(label);
  }
  if (fittings.length) pushAttr(attributes, seen, 'Fittings requested', fittings.join(', '), 'shorthand');

  return { attributes, designPressure, tempMax, connection, materials, instrumentStyle, fittings };
}

/** Everything readable from an enquiry, whichever style it is written in.
 * Shorthand codes ("10KG", "TRM-SS316") and prose label/value pairs
 * ("Sheath Dia : 6 mm") both occur, sometimes in the same message. */
function readEnquiryAttributes(text) {
  const { parseLabelledAttributes } = require('./compareAttributes');
  const shorthand = parseEngineeringShorthand(text);
  const labelled = parseLabelledAttributes(text);
  const seen = new Set(shorthand.attributes.map((a) => a.label.toLowerCase()));
  const merged = [...shorthand.attributes];
  for (const a of labelled) {
    if (seen.has(a.label.toLowerCase())) continue;
    seen.add(a.label.toLowerCase());
    merged.push(a);
  }
  return { ...shorthand, attributes: merged, labelled };
}

module.exports = { parseEngineeringShorthand, readEnquiryAttributes };
