// server/src/services/parseEnquiryText.js
//
// Lightweight structured extraction of an enquiry's stated range/temp/area/
// output, for DISPLAY only (the "Enquiry requirement" column on the
// matching page). This does NOT decide the match — that's the LLM's job in
// matchEnquiry.js, which reads the full raw enquiry text itself and can
// reason about accuracy, connection, media, etc. that this regex pass
// doesn't attempt to capture.

const { CATEGORY_ALIASES } = require('./categoryAliases');
const { readEnquiryAttributes } = require('./parseEngineeringShorthand');

const HAZARD_TERMS = /\b(ATEX|Ex[\s-]?d|Ex[\s-]?ia|flameproof|flame[\s-]?proof|explosion[\s-]?proof|hazardous area|classified area|Zone\s?[0-2])\b/i;
const SAFE_TERMS = /\b(weatherproof|weather[\s-]?proof|safe area)\b/i;
const OUTPUT_TERMS = {
  hart: /\bHART\b/i,
  modbus: /\bModbus\b/i,
  switch: /\b(switch|SPDT|SPST|on\/?off|alarm)\b/i,
  '4-20mA': /\b4[\s-]?20\s?mA\b/i,
  visual: /\b(gauge|visual|indicator|dial)\b/i,
};
const RANGE_PATTERN = /(-?\d+(?:\.\d+)?)\s*(?:to|-|~)\s*(-?\d+(?:\.\d+)?)\s*(bar|kg\/cm2|kg\/cm²|psi|mbar|mmwc|°c|c\b|mm)?/gi;
const SINGLE_VALUE_PATTERN = /\b(\d+(?:\.\d+)?)\s*(bar|kg\/cm2|kg\/cm²|psi|mbar|°c|c\b)\b/gi;

function parseEnquiryText(text) {
  const hazardMatch = HAZARD_TERMS.test(text);
  const safeMatch = SAFE_TERMS.test(text);
  const hazardous = hazardMatch && safeMatch ? 'both' : hazardMatch ? 'flameproof' : safeMatch ? 'safe' : null;

  const outputCandidates = Object.entries(OUTPUT_TERMS)
    .filter(([, re]) => re.test(text))
    .map(([key]) => key);

  let range = null;
  const rangeMatch = RANGE_PATTERN.exec(text);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);
    if (!Number.isNaN(min) && !Number.isNaN(max)) range = { min, max };
  }

  let tempMax = null;
  SINGLE_VALUE_PATTERN.lastIndex = 0;
  let m;
  while ((m = SINGLE_VALUE_PATTERN.exec(text)) !== null) {
    if (/c$/i.test(m[2])) { tempMax = parseFloat(m[1]); break; }
  }

  // Compressed shorthand ("10KG,100 DEGGC,PC-1\"ASA 150#,TRM-SS316") carries the
  // same requirements as prose but matches none of the patterns above. Read it
  // too, and let it fill gaps the prose patterns left empty.
  //
  // Design pressure is deliberately NOT folded into `range`: the pressure a
  // level gauge is BUILT for is not the range it MEASURES, and treating one as
  // the other would score every candidate against the wrong number.
  const shorthand = readEnquiryAttributes(text);
  if (tempMax == null && shorthand.tempMax != null) tempMax = shorthand.tempMax;

  return {
    rawText: text,
    range,
    tempMax,
    hazardous,
    outputCandidates,
    connectionRaw: shorthand.connection || null,
    moc: shorthand.materials.length ? shorthand.materials.join(', ') : null,
    designPressure: shorthand.designPressure || null,
    instrumentStyle: shorthand.instrumentStyle || null,
    shorthand,
  };
}

/**
 * Guess which product category an enquiry belongs to, so we only fetch/score
 * that family's products instead of the whole catalogue. Category labels
 * often carry a parenthetical qualifier ("Pressure transmitter (4-20 mA)",
 * "Level gauge (visual indication)") that real enquiry text will almost
 * never contain verbatim — so matching is done on the CORE phrase (before
 * the parenthesis), with the parenthetical content and category id kept as
 * secondary signals. Longest core phrase wins ties, so "Smart pressure
 * transmitter" beats the more generic "Pressure transmitter". Returns null
 * on no match.
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary test rather than a plain substring check. Short aliases like
// "lg" (Level Gauge) or "pg" (Pressure Gauge) are exactly the kind of thing a
// customer types in a terse enquiry line (e.g. "LG,FINISHED,TUBLR,CC-1450MM")
// — but a naive `.includes('lg')` also matches inside totally unrelated words
// ("sealing", "flange", "single"...), and `.includes('pg')` matches inside
// "upgrade". \b...\b anchors the alias to its own token so "LG" alone still
// matches (comma/whitespace count as boundaries) without those false hits.
function containsTerm(lower, term) {
  if (!term) return false;
  return new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(lower);
}

function detectCategory(text, categories) {
  if (!text || !categories || !categories.length) return null;
  const lower = text.toLowerCase();
  const candidates = categories
    .map((c) => {
      const label = c.label.toLowerCase();
      const core = label.split('(')[0].trim();
      // Qualifier terms like "on/off" or "float, on/off" split into pieces
      // too short and generic to be safe substring checks (e.g. "on" would
      // false-positive-match inside "bourdon") — only keep pieces specific
      // enough to be a real signal.
      const qualifier = (label.match(/\(([^)]+)\)/)?.[1] || '')
        .split(/[/,]/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 4);
      const aliases = CATEGORY_ALIASES[c.id] || [];
      return { id: c.id, core, terms: [core, c.id.replace(/_/g, ' '), ...qualifier, ...aliases] };
    })
    // Longest term first, not just longest core label — an alias like
    // "resistance temperature detector" should out-rank a shorter, more
    // generic label elsewhere winning on core-length alone.
    .sort((a, b) => Math.max(...b.terms.map((t) => t.length)) - Math.max(...a.terms.map((t) => t.length)));
  for (const c of candidates) {
    if (c.terms.some((t) => containsTerm(lower, t))) return c.id;
  }
  return null;
}

module.exports = { parseEnquiryText, detectCategory };
