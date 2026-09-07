// web/src/lib/clientMatcher.js
//
// This is a browser-side, simplified port of matching_engine_reference.js
// (the real server-side scoring model — range 30%, hazard 20%, output 15%,
// temp 15%, media 10%, connection 10%). It's simplified to 4 criteria here
// (range/hazard/output/temp) because the list-products endpoint doesn't
// return media/connection detail — the full model needs the per-product
// detail endpoint for that, which isn't worth an extra fetch per candidate
// in a live-typing chat UI. When the real /enquiries + /matches backend
// exists (Phase 6), THIS FILE GOES AWAY and the UI calls that API instead —
// it exists only so the frontend has genuinely dynamic behaviour to
// demonstrate against real seeded product data in the meantime.

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

/** Parse free-typed enquiry text into a structured requirement. Never throws. */
export function parseEnquiry(text) {
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

  return { rawText: text, range, tempMax, hazardous, outputCandidates };
}

function scoreRange(requested, product) {
  if (!requested || product.val_max == null) return 0.5;
  const prodMin = Number(product.val_min);
  const prodMax = Number(product.val_max);
  if (requested.max <= prodMax && requested.min >= prodMin) {
    // Fully covers the ask. Still prefer a snug fit over a wildly oversized
    // range — e.g. a requested 0–10 bar shouldn't score identically to a
    // -1–400 bar model just because 0–10 technically fits inside it.
    const prodSpan = prodMax - prodMin;
    if (prodSpan <= 0) return 1.0;
    const reqSpan = requested.max - requested.min;
    const tightness = Math.min(1, reqSpan / prodSpan);
    return 0.75 + 0.25 * tightness;
  }
  if (prodMax <= 0) return 0.4;
  const overshoot = Math.abs(requested.max - prodMax) / Math.max(Math.abs(prodMax), 1);
  return Math.max(0, 1 - overshoot);
}

/**
 * Guess which product category an enquiry belongs to, so matching only runs
 * against relevant products instead of the entire catalogue (e.g. a
 * "pressure transmitter" enquiry shouldn't be scored against temperature
 * transmitters or level switches). Matches on category label / id first
 * (longest label wins, so "smart pressure transmitter" beats the more
 * generic "pressure transmitter"), never throws, returns null on no match
 * so callers can fall back to searching the whole catalogue.
 * @param {string} text
 * @param {Array<{id: string, label: string}>} categories
 * @returns {string|null} category id
 */
export function detectCategory(text, categories) {
  if (!text || !categories || !categories.length) return null;
  const lower = text.toLowerCase();
  const candidates = categories
    .map((c) => ({ id: c.id, terms: [c.label.toLowerCase(), c.id.replace(/_/g, ' ')] }))
    .sort((a, b) => b.terms[0].length - a.terms[0].length);
  for (const c of candidates) {
    if (c.terms.some((t) => t && lower.includes(t))) return c.id;
  }
  return null;
}

function scoreHazard(requested, product) {
  if (!requested) return 0.5;
  if (product.hazardous === 'both' || product.hazardous === requested) return 1.0;
  return 0.0; // hard fail, matches the server-side rule: never partial-credit a safety mismatch
}

function scoreOutput(candidates, product) {
  if (!candidates || candidates.length === 0) return 0.5;
  if (candidates.includes(product.output_type)) return 1.0;
  if (candidates.includes('4-20mA') && product.output_type === 'hart') return 0.85;
  return 0.2;
}

function scoreTemp(requested, product) {
  if (requested == null || product.temp_max == null) return 0.5;
  return requested <= Number(product.temp_max) ? 1.0 : 0.3;
}

/**
 * @param {object} parsed - from parseEnquiry()
 * @param {Array} products - from api.getProducts()
 * @returns ranked array of { product, percent, band, criteria, deviations }
 */
export function matchProducts(parsed, products) {
  const scored = products.map((product) => {
    const range = scoreRange(parsed.range, product);
    const hazard = scoreHazard(parsed.hazardous, product);
    const output = scoreOutput(parsed.outputCandidates, product);
    const temp = scoreTemp(parsed.tempMax, product);

    const percentRaw = range * 0.35 + hazard * 0.25 + output * 0.20 + temp * 0.20;
    const hardFail = hazard === 0;
    const percent = Math.round((hardFail ? Math.min(percentRaw, 0.59) : percentRaw) * 100);

    const deviations = [];
    if (hardFail && parsed.hazardous) {
      deviations.push({ type: 'hard_mismatch', text: `Requested ${parsed.hazardous} area — this model is rated "${product.hazardous}".` });
    }
    if (parsed.range && range < 0.9 && range > 0) {
      deviations.push({ type: 'partial_fit', text: `Requested range ${parsed.range.min}–${parsed.range.max} is a stretch against this model's ${product.val_min}–${product.val_max} rating.` });
    }
    if (parsed.outputCandidates.length && output < 0.9 && output > 0.2) {
      deviations.push({ type: 'partial_fit', text: `Requested ${parsed.outputCandidates.join('/')}; this model offers ${product.output_type}.` });
    }
    if (parsed.tempMax != null && temp < 1) {
      deviations.push({ type: 'partial_fit', text: `Requested up to ${parsed.tempMax}°C exceeds this model's ${product.temp_max}°C rating.` });
    }

    const matchingSpecs = [];
    if (range >= 0.9) matchingSpecs.push(`Range covers ${product.val_min} to ${product.val_max}`);
    if (hazard === 1 && parsed.hazardous) matchingSpecs.push(`Area classification (${product.hazardous}) matches`);
    if (output >= 0.9) matchingSpecs.push(`Output (${product.output_type}) matches`);
    if (temp === 1 && parsed.tempMax != null) matchingSpecs.push(`Temperature rating (${product.temp_max}°C) covers requirement`);

    return {
      product,
      percent,
      band: percent >= 85 ? 'strong' : percent >= 60 ? 'workable' : 'weak',
      criteria: { range, hazard, output, temp },
      deviations,
      matchingSpecs,
    };
  });

  scored.sort((a, b) => b.percent - a.percent);
  scored.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}
