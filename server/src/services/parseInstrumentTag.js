// server/src/services/parseInstrumentTag.js
//
// Reads the instrument type out of a customer's tag number.
//
// Instrument tags follow ISA-5.1: the first letter is the measured VARIABLE
// (P pressure, T temperature, L level, F flow...), the following letters are
// the FUNCTION (I indicator, T transmitter, S switch, E element, G gauge,
// W well), and a leading D means DIFFERENTIAL.
//
// This matters because the tag is often the most reliable statement of what
// the customer wants, and the pipeline was throwing it away. In the real P19
// NTEPL enquiry, three of the ten tags are DPT504B-1, DPT513-1, DPT516-1 —
// DIFFERENTIAL pressure transmitters — sitting in a sheet titled "PRESSURE
// TRANSMITTER" whose columns are identical to the plain PT rows. Nothing else
// in those rows says "differential". Without reading the tag, all ten look
// like the same product and three of them get matched to the wrong family.
//
// Deliberately deterministic: no LLM call. A tag is a code, not prose.

const VARIABLES = {
  P: 'pressure',
  T: 'temperature',
  L: 'level',
  F: 'flow',
  A: 'analysis',
  V: 'vibration',
  W: 'weight',
  S: 'speed',
  Z: 'position',
};

const FUNCTIONS = {
  I: 'indicator',
  T: 'transmitter',
  S: 'switch',
  E: 'element',
  G: 'gauge',
  W: 'well',
  C: 'controller',
  R: 'recorder',
  V: 'valve',
  Y: 'relay',
  A: 'alarm',
};

// Devices this catalogue does not sell. Recognised so they can be reported as
// out of scope rather than silently matched to the nearest instrument.
const OUT_OF_SCOPE_FUNCS = new Set(['valve', 'controller', 'recorder', 'relay']);

// Which catalogue category a tag most likely points at. Keys are
// "<variable>_<function>" with the differential flag folded in where the
// distinction is a different product family, not just a different range.
const CATEGORY_HINTS = {
  pressure_transmitter: 'pressure_transmitter',
  'pressure_transmitter#diff': 'dp_transmitter',
  pressure_indicator: 'pressure_gauge',
  pressure_gauge: 'pressure_gauge',
  pressure_switch: 'pressure_switch',
  'pressure_switch#diff': 'dp_switch',
  temperature_indicator: 'temperature_gauge',
  temperature_gauge: 'temperature_gauge',
  temperature_transmitter: 'temperature_transmitter',
  temperature_element: 'temperature_element',
  temperature_well: 'thermowell',
  temperature_switch: 'temp_switch',
  level_gauge: 'level_gauge',
  level_indicator: 'level_gauge',
  level_transmitter: 'level_transmitter',
  level_switch: 'level_switch',
};

/** Leading alphabetic run of a token, e.g. "PT510" -> "PT", "P025" -> "P". */
function alphaPrefix(token) {
  const m = String(token).match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}

function hasDigitsAfter(token) {
  return /^[A-Za-z]+\d/.test(String(token));
}

/**
 * Score how much a token looks like an instrument tag prefix. Real tags carry
 * plant/area prefixes ("WL_PI-P025", "21-TI-1005A"), so we score every segment
 * and take the best rather than assuming the tag starts at character one.
 */
function scoreSegment(token) {
  const prefix = alphaPrefix(token);
  if (!prefix || prefix.length > 4) return { score: 0 };

  let rest = prefix;
  let differential = false;
  if (rest.length >= 2 && rest[0] === 'D' && VARIABLES[rest[1]]) {
    differential = true;
    rest = rest.slice(1);
  }

  const variable = VARIABLES[rest[0]];
  if (!variable) return { score: 0 };

  let score = 2;
  if (differential) score += 1;

  const funcLetters = rest.slice(1).split('');
  const funcs = funcLetters.map((l) => FUNCTIONS[l]).filter(Boolean);
  if (funcs.length) score += 2;
  if (hasDigitsAfter(token)) score += 1;

  // Use the LAST recognised function letter, not the first: in ISA-5.1 the
  // final letter is the actual device. "TIT" is a temperature indicating
  // TRANSMITTER, and "PSV" is a pressure safety VALVE — taking the first
  // function letter would call that one a pressure switch and route it to
  // completely the wrong product family.
  return { score, prefix, variable, differential, func: funcs[funcs.length - 1] || null, funcs };
}

/**
 * @param {string} tag e.g. "PT510-2", "DPT504B-1", "WL_PI-P025", "21-TI-1005A"
 * @returns {null | {
 *   raw: string, prefix: string, variable: string, func: string|null,
 *   differential: boolean, label: string, categoryHint: string|null
 * }}
 */
function parseInstrumentTag(tag) {
  if (!tag) return null;
  // A real instrument tag carries a loop number. Requiring a digit stops
  // ordinary words being read as tags — without it "ABC" parses as an
  // "analysis controller" and quietly steers the match.
  if (!/\d/.test(String(tag))) return null;
  const segments = String(tag).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!segments.length) return null;

  let best = { score: 0 };
  for (const seg of segments) {
    const s = scoreSegment(seg);
    if (s.score > best.score) best = s;
  }
  if (!best.score || !best.variable) return null;

  const label = [
    best.differential ? 'differential' : null,
    best.variable,
    best.func,
  ].filter(Boolean).join(' ');

  const key = `${best.variable}_${best.func || ''}`;
  const categoryHint = CATEGORY_HINTS[best.differential ? `${key}#diff` : key]
    || CATEGORY_HINTS[key]
    || null;

  return {
    raw: String(tag),
    outOfScope: OUT_OF_SCOPE_FUNCS.has(best.func),
    prefix: best.prefix,
    variable: best.variable,
    func: best.func,
    differential: best.differential,
    label,
    categoryHint,
  };
}

/**
 * A single line appended to the enquiry text handed to the classifier and the
 * matcher. Stated as an interpretation of the tag rather than as fact, so the
 * model can override it when the row says otherwise — the tag is strong
 * evidence, not gospel, and mislabelled tags do occur.
 */
function tagHintLine(tag) {
  const parsed = parseInstrumentTag(tag);
  if (!parsed || !parsed.func) return null;
  if (parsed.outOfScope) {
    return `INSTRUMENT TAG: ${parsed.raw} — the tag prefix "${parsed.prefix}" indicates a ${parsed.label}, ` +
      `which is NOT a Forbes Marshall Hyderabad instrument. Report this line as out of scope rather than matching it.`;
  }
  return `INSTRUMENT TAG: ${parsed.raw} — the tag prefix "${parsed.prefix}" indicates a ${parsed.label}` +
    (parsed.differential ? ' (DIFFERENTIAL, not a plain gauge/transmitter)' : '') + '.';
}

module.exports = { parseInstrumentTag, tagHintLine, VARIABLES, FUNCTIONS };
