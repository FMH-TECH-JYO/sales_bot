// server/src/services/preprocess.js
//
// Per the architecture: numeric values and hazard-area language are exactly
// the kind of task classical text processing already does reliably — reserve
// the LLM's limited capacity (especially at 1B) for the genuinely
// language-shaped parts (family name, blurb, industries).
//
// This does NOT replace the LLM draft — it runs alongside it and is used to
// cross-validate: if the regex pass and the LLM agree on a value, that's a
// high-confidence field. If only the LLM found something with no
// corroborating regex evidence, flag it for review rather than trusting it.

const HAZARD_TERMS = /\b(ATEX|Ex[\s-]?d|Ex[\s-]?ia|flameproof|flame[\s-]?proof|explosion[\s-]?proof|hazardous area|classified area|Zone\s?[0-2])\b/i;
// NOTE: "general purpose" was in this list originally but had to be removed —
// it appears in every microswitch contact-rating table (safe AND flameproof
// datasheets alike, e.g. "1 SPDT general purpose, 5-15A/250VAC" as a contact
// spec) and caused false "both" classifications. Caught via a real test
// against the FD (flameproof-only) datasheet, which was scoring 0.2
// confidence on a correct "flameproof" answer because of this false positive.
const SAFE_AREA_TERMS = /\b(weatherproof|weather[\s-]?proof|safe area)\b/i;

const OUTPUT_TERMS = {
  hart: /\bHART\b/i,
  modbus: /\bModbus\b/i,
  switch: /\b(SPDT|SPST|snap[\s-]?action|micro[\s-]?switch)\b/i,
  '4-20mA': /\b4[\s-]?20\s?mA\b/i,
};

// Matches things like "0.1 + 1", "-200 to +200", "0 to 10 bar", "0-50 bar"
const RANGE_PATTERN = /(-?\d+(?:\.\d+)?)\s*(?:to|-|\+|~)\s*(-?\d+(?:\.\d+)?)\s*(bar|kg\/cm2|kg\/cm²|psi|mbar|mmwc|°c|c\b)?/gi;

/**
 * @param {string} text - raw parsed PDF text
 * @returns {{ hazardCandidate: string|null, outputCandidates: string[], rangeCandidates: Array<{min:number,max:number,unit:string|null}> }}
 */
function preprocess(text) {
  const hazardMatch = HAZARD_TERMS.test(text);
  const safeMatch = SAFE_AREA_TERMS.test(text);
  const hazardCandidate = hazardMatch && safeMatch ? 'both' : hazardMatch ? 'flameproof' : safeMatch ? 'safe' : null;

  const outputCandidates = Object.entries(OUTPUT_TERMS)
    .filter(([, re]) => re.test(text))
    .map(([key]) => key);

  const rangeCandidates = [];
  let m;
  RANGE_PATTERN.lastIndex = 0;
  while ((m = RANGE_PATTERN.exec(text)) !== null && rangeCandidates.length < 20) {
    const min = parseFloat(m[1]);
    const max = parseFloat(m[2]);
    if (!Number.isNaN(min) && !Number.isNaN(max) && min <= max) {
      rangeCandidates.push({ min, max, unit: m[3] ? m[3].toLowerCase() : null });
    }
  }

  return { hazardCandidate, outputCandidates, rangeCandidates };
}

/**
 * Cross-validate an LLM-extracted field against the regex pass.
 * Returns a confidence score: agreement = high, no corroboration = low.
 * This is the "don't trust the model to grade itself" rule from the plan.
 */
function crossValidateHazard(llmValue, preprocessed) {
  if (!llmValue) return 0.3;
  if (preprocessed.hazardCandidate === llmValue) return 0.9;
  if (preprocessed.hazardCandidate === null) return 0.5;
  return 0.2;
}

function crossValidateOutput(llmValue, preprocessed) {
  if (!llmValue) return 0.3;
  if (preprocessed.outputCandidates.includes(llmValue)) return 0.9;
  if (preprocessed.outputCandidates.length === 0) return 0.5;
  return 0.3;
}

module.exports = { preprocess, crossValidateHazard, crossValidateOutput };