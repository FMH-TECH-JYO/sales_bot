// server/src/services/compareAttributes.js
//
// Field-by-field comparison of what the enquiry ASKED FOR against what the
// matched product ACTUALLY IS — driven by the attributes each side really
// states, not by a fixed list of columns.
//
// WHY
// ---
// The old comparison had six hard-coded parameters: range, max temperature,
// area classification, output type, accuracy, process connection. That works
// for a pressure switch. Put a real RTD enquiry through it:
//
//   "RTD Length : 300 mm  Type : PT 100, 3 Wire  No. of circuit : Two (Double
//    element)  Sheath Dia : 6 mm  Sheath Material : SS 316
//    Process Connection : 1/2\" NPT(M) Adjustable Compression Fitting,
//    SS304 Terminal"
//
// Eight clear requirements. Exactly ONE of them (process connection) has a
// column. An RTD has no pressure range, so "Range: not specified" is true and
// useless. The screen showed six rows of dashes and scored 0% — not because
// the product was wrong, but because the comparison had nothing to compare.
//
// So: read the attributes the enquiry states, read the attributes the product
// has (fixed fields AND its spec table), align them by label, and compare
// value by value. A product family's important attributes differ — sheath
// diameter for an RTD, bourdon material for a gauge, differential for a switch
// — and this compares whatever each side actually says.
//
// Deterministic. No model call. Values here are codes and measurements.

const UNIT_ALIASES = {
  mm: 'mm', millimetre: 'mm', millimeter: 'mm', mms: 'mm',
  m: 'm', cm: 'cm', inch: 'in', in: 'in', '"': 'in',
  degc: '°C', c: '°C', '°c': '°C', celsius: '°C',
  bar: 'bar', barg: 'bar', mbar: 'mbar',
  'kg/cm2': 'kg/cm²', 'kg/cm²': 'kg/cm²', kg: 'kg/cm²',
  psi: 'psi', psig: 'psi', mmwc: 'mmWC', mmhg: 'mmHg',
};

// Label synonyms. Customers and datasheets rarely use the same words for the
// same thing, and a comparison that only matches exact labels reports every
// requirement as "not confirmed".
const LABEL_SYNONYMS = [
  ['sheath dia', 'sheath diameter', 'sheath od', 'probe diameter', 'element diameter'],
  ['sheath material', 'sheath moc', 'sheath', 'sheath matl'],
  ['sheath length', 'insertion length', 'rtd length', 'probe length', 'immersion length', 'length'],
  ['process connection', 'process conn', 'connection', 'proc conn', 'fitting'],
  ['wire configuration', 'wire', 'wires', 'no of wires', 'wiring'],
  ['element', 'type', 'sensor type', 'element type'],
  ['no of circuit', 'number of circuits', 'circuits', 'duplex/simplex', 'configuration'],
  ['terminal', 'terminal block', 'termination', 'terminal head'],
  ['accuracy', 'tolerance', 'accuracy class', 'class'],
  ['max temp', 'maximum temperature', 'temperature', 'temp', 'operating temperature', 'design temperature'],
  ['range', 'measuring range', 'span', 'measurement range'],
  ['area classification', 'area', 'hazardous area', 'protection'],
  ['output', 'output type', 'output signal', 'signal'],
  ['material', 'moc', 'material of construction', 'wetted parts'],
  ['reference standard', 'standard', 'std', 'as per'],
];

const STOPWORDS = new Set(['the', 'a', 'of', 'for', 'with', 'and', 'or', 'to', 'as', 'per', 'is']);

function normaliseLabel(label) {
  const l = String(label || '').toLowerCase().trim()
    .replace(/[().:,;]/g, ' ')
    .replace(/\bdia\b/g, 'diameter')
    .replace(/\bmatl\b/g, 'material')
    .replace(/\bmoc\b/g, 'material')
    .replace(/\bconn\b/g, 'connection')
    .replace(/\btemp\b/g, 'temperature')
    .replace(/\bno\b/g, 'number')
    .replace(/\s+/g, ' ')
    .trim();
  return l;
}

/**
 * Canonical key for a label, folding synonyms onto the first term in a group.
 *
 * Three passes, in this order, because a single loose substring test produced
 * silently wrong alignments:
 *   - "Element" was captured by "element diameter" (t.includes(n)), so the
 *     enquiry's Sheath Dia compared against "Pt100, film type";
 *   - "Sheath length" was captured by the bare term "sheath" (n.includes(t)),
 *     so a 300 mm vs 450 mm length difference never surfaced as a deviation;
 *   - "Output type" was captured by the bare term "type".
 * Every one of those looked plausible on screen and was wrong.
 */
function labelKey(label) {
  const n = normaliseLabel(label);
  if (!n) return n;

  // 1. Exact name. "Sheath diameter", "Output type", "Element" all resolve here
  //    to their own group and can no longer be stolen by a longer phrase.
  for (const group of LABEL_SYNONYMS) {
    for (const term of group) {
      if (normaliseLabel(term) === n) return normaliseLabel(group[0]);
    }
  }

  // 2. Ends with a MULTI-WORD known name; longest wins.
  //    "Customer sheath material" -> sheath material.
  let best = null;
  for (const group of LABEL_SYNONYMS) {
    for (const term of group) {
      const t = normaliseLabel(term);
      if (t.split(' ').length < 2) continue;
      if (n.endsWith(' ' + t) && (!best || t.length > best.t.length)) best = { t, group };
    }
  }
  if (best) return normaliseLabel(best.group[0]);

  // 3. Last resort: ends with a single-word known name.
  for (const group of LABEL_SYNONYMS) {
    for (const term of group) {
      const t = normaliseLabel(term);
      if (t.split(' ').length === 1 && n.endsWith(' ' + t)) return normaliseLabel(group[0]);
    }
  }

  return n;
}

/**
 * "6 mm" -> {n: 6, unit: 'mm'}; "1/2\"" -> {n: 0.5, unit: 'in'}
 *
 * Anchored to the WHOLE string on purpose. An unanchored search treated
 * "PT 100, 3 Wire" and "Pt100, film type" as the quantities 100 and 100 with
 * no unit, declared them equal, and reported a MATCH on an element type whose
 * wire configuration was never confirmed. A value that is prose containing a
 * number is not a measurement — return null and let the text comparison judge it.
 */
function parseQuantity(value) {
  const s = String(value || '').trim();
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)\s*("|in|inch)?$/i);
  if (frac) return { n: Number(frac[1]) / Number(frac[2]), unit: 'in' };
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*("|°?\s?[A-Za-z/²]{0,6})?$/);
  if (!m) return null;
  const raw = (m[2] || '').toLowerCase().replace(/\s/g, '');
  return { n: parseFloat(m[1]), unit: UNIT_ALIASES[raw] || (raw || null) };
}

/** SS 316 == SS316; SS316L != SS316 (different alloy, worth flagging). */
function normaliseMaterial(v) {
  return String(v || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9]/g, '');
}

function tokens(v) {
  return String(v || '').toLowerCase().split(/[^a-z0-9./"]+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

/**
 * Compare one requested value against one actual value.
 * @returns {{verdict: 'match'|'deviation'|'unclear', note: string}}
 */
function compareValue(requested, actual) {
  const req = String(requested ?? '').trim();
  const act = String(actual ?? '').trim();
  if (!req) return { verdict: 'unclear', note: 'Not requested' };
  if (!act) return { verdict: 'unclear', note: 'Product datasheet does not state this' };

  // exact / case-insensitive
  if (req.toLowerCase() === act.toLowerCase()) return { verdict: 'match', note: 'Exact match' };

  // material codes
  const rm = normaliseMaterial(req), am = normaliseMaterial(act);
  if (rm && am && /^[A-Z]{1,3}\d{3}/.test(rm)) {
    if (rm === am) return { verdict: 'match', note: 'Same material' };
    if (am.includes(rm) || rm.includes(am)) {
      return { verdict: 'deviation', note: `Requested ${req}, product is ${act} — similar grade, confirm acceptable` };
    }
  }

  // quantities
  const rq = parseQuantity(req), aq = parseQuantity(act);
  if (rq && aq && rq.unit === aq.unit) {
    if (rq.n === aq.n) return { verdict: 'match', note: 'Exact match' };
    const pct = rq.n === 0 ? 100 : Math.abs((aq.n - rq.n) / rq.n) * 100;
    return {
      verdict: 'deviation',
      note: `Requested ${req}, product is ${act}` + (pct < 100 ? ` (${pct.toFixed(0)}% different)` : ''),
    };
  }
  if (rq && aq && rq.unit !== aq.unit) {
    return { verdict: 'deviation', note: `Requested ${req}, product is ${act} — different units, needs checking` };
  }

  // text containment: "3 Wire" inside "3-wire, Pt100 Class A"
  const despace = (v) => String(v).toLowerCase().replace(/([a-z])\s+(\d)/g, '$1$2');
  const rt = tokens(despace(req)), at = tokens(despace(act));
  if (rt.length && rt.every((t) => at.includes(t))) {
    return { verdict: 'match', note: `Product spec "${act}" covers "${req}"` };
  }
  const overlap = rt.filter((t) => at.includes(t)).length;
  if (overlap > 0 && overlap >= rt.length / 2) {
    return { verdict: 'deviation', note: `Requested ${req}, product states ${act} — partial match, confirm` };
  }

  return { verdict: 'deviation', note: `Requested ${req}, product is ${act}` };
}

/**
 * Build the full comparison.
 * @param {Array<{label,value}>} requested  attributes stated by the enquiry
 * @param {Array<{label,value}>} actual     attributes the product has
 * @returns {{rows: Array, matched: number, deviations: number, unconfirmed: number, score: number}}
 */
function compareAttributes(requested = [], actual = []) {
  const actualByKey = new Map();
  for (const a of actual) {
    if (!a || !a.label) continue;
    const k = labelKey(a.label);
    if (!actualByKey.has(k)) actualByKey.set(k, a);
  }

  const rows = [];
  let matched = 0, deviations = 0, unconfirmed = 0;

  const ROLLUP_LABELS = new Set(['materials mentioned', 'fittings requested']);

  for (const r of requested) {
    if (!r || !r.label) continue;
    if (ROLLUP_LABELS.has(normaliseLabel(r.label))) continue;
    const key = labelKey(r.label);
    const found = actualByKey.get(key) || null;
    const { verdict, note } = compareValue(r.value, found ? found.value : null);

    if (verdict === 'match') matched++;
    else if (verdict === 'deviation') deviations++;
    else unconfirmed++;

    rows.push({
      parameter: r.label,
      requested: r.value,
      actual: found ? found.value : null,
      actualLabel: found ? found.label : null,
      verdict,
      note,
    });
  }

  const comparable = matched + deviations;
  // Unconfirmed attributes do NOT count as matches. A product the datasheet is
  // silent about has not satisfied the requirement — the app's stated rule is
  // that unconfirmed is reported as missing, never assumed.
  const score = comparable === 0 ? 0 : Math.round((matched / (matched + deviations + unconfirmed)) * 100);

  return { rows, matched, deviations, unconfirmed, score };
}

/**
 * The attributes a product states: fixed columns plus its whole spec table.
 * Nulls are skipped so a blank column is never presented as an answer — the
 * old screen rendered empty range/temperature as "Range: to" and "Max temp: °C".
 */
function productAttributes(product) {
  const out = [];
  const push = (label, value) => {
    if (value === null || value === undefined || String(value).trim() === '') return;
    out.push({ label, value: String(value) });
  };

  if (product.val_min != null || product.val_max != null) {
    push('Range', `${product.val_min ?? '?'} to ${product.val_max ?? '?'}${product.range_unit ? ' ' + product.range_unit : ''}`);
  }
  push('Max temperature', product.temp_max != null ? `${product.temp_max} °C` : null);
  push('Area classification', product.hazardous);
  push('Output type', product.output_type);
  push('Accuracy', product.accuracy);
  push('Process connection', product.connection);

  for (const s of product.extra_specs || []) {
    if (s && s.label) push(s.label, s.value);
  }
  return out;
}

/** The phrase IS a known attribute name (not merely ends with one). */
function isExactLabel(phrase) {
  const n = normaliseLabel(phrase);
  if (!n) return false;
  return LABEL_SYNONYMS.some((group) => group.some((term) => normaliseLabel(term) === n));
}

/** The phrase ends with a known attribute name, e.g. "Discharge RTD Length". */
function isSuffixLabel(phrase) {
  const n = normaliseLabel(phrase);
  if (!n) return false;
  return LABEL_SYNONYMS.some((group) => group.some((term) => n.endsWith(' ' + normaliseLabel(term))));
}

function isKnownLabel(phrase) {
  return isExactLabel(phrase) || isSuffixLabel(phrase);
}

/**
 * Parse prose written as "Label : Value  Label : Value", the second common
 * enquiry shape after compressed shorthand:
 *
 *   RTD Length : 300 mm  Type : PT 100, 3 Wire  Sheath Dia : 6 mm
 *
 * Split on the colons rather than regex-matching pairs. Each middle segment
 * holds "<value of the previous label> <label for the next colon>", and the
 * hard part is knowing where the value ends and the next label starts:
 * "300 mm Type" is the value "300 mm" plus the label "Type", and a naive
 * lookahead steals the unit, producing "Length = 300" and "mm Type = ...".
 *
 * So trailing word-runs are tested longest-first against the synonym table,
 * and a run that names a known attribute wins. Otherwise fall back to the last
 * word or two, stopping at anything containing a digit, quote or bracket —
 * those belong to the value.
 */
function splitValueAndNextLabel(segment) {
  const words = String(segment || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { value: '', nextLabel: null };

  const isLabelWord = (w) => /^[A-Za-z][A-Za-z.]*$/.test(w);

  // Prefer the LONGEST run that is exactly a known attribute name.
  // "Pump Discharge RTD Length" -> both "RTD Length" and "Length" are known,
  // and "RTD Length" is the one the customer wrote; "Pump Discharge" is the
  // value of the previous label. Testing longest-first for an EXACT match
  // picks it, where a suffix test would swallow "Pump Discharge" into the
  // label and a shortest-first test would leave "RTD" stranded in the value.
  for (let take = Math.min(4, words.length); take >= 1; take--) {
    const run = words.slice(words.length - take);
    if (!run.every(isLabelWord)) continue;
    const candidate = run.join(' ');
    if (isExactLabel(candidate)) {
      return { value: words.slice(0, words.length - take).join(' ').trim(), nextLabel: candidate };
    }
  }
  // No exact hit — fall back to the SHORTEST run that ends with a known name,
  // so only the naming words are taken and the rest stays as the value.
  for (let take = 1; take <= Math.min(4, words.length); take++) {
    const run = words.slice(words.length - take);
    if (!run.every(isLabelWord)) break;
    const candidate = run.join(' ');
    if (isSuffixLabel(candidate)) {
      return { value: words.slice(0, words.length - take).join(' ').trim(), nextLabel: candidate };
    }
  }

  let take = 0;
  while (take < 2 && take < words.length && isLabelWord(words[words.length - 1 - take])) take++;
  if (!take) return { value: words.join(' '), nextLabel: null };
  return {
    value: words.slice(0, words.length - take).join(' ').trim(),
    nextLabel: words.slice(words.length - take).join(' '),
  };
}

function parseLabelledAttributes(text) {
  const raw = String(text || '');
  if (!raw.includes(':')) return [];
  const parts = raw.split(':');
  if (parts.length < 2) return [];

  const out = [];
  const seen = new Set();

  let pendingLabel = splitValueAndNextLabel(parts[0]).nextLabel;
  for (let i = 1; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const { value, nextLabel } = isLast
      ? { value: parts[i].trim(), nextLabel: null }
      : splitValueAndNextLabel(parts[i]);

    if (pendingLabel && value) {
      const clean = value.replace(/[,;]\s*$/, '').trim();
      const key = normaliseLabel(pendingLabel);
      if (clean && !seen.has(key) && pendingLabel.length <= 40) {
        seen.add(key);
        out.push({ label: pendingLabel, value: clean, source: 'labelled' });
      }
    }
    pendingLabel = nextLabel;
  }
  return out;
}

module.exports = {
  compareAttributes, productAttributes, labelKey, compareValue, parseQuantity,
  parseLabelledAttributes, normaliseLabel, isKnownLabel,
};
