// server/src/services/matchEnquiry.js
//
// Phase 6: turns a free-text enquiry into a ranked list of real catalogue
// products. Two-stage pipeline, same "classical text processing for the
// deterministic parts, LLM for the language-shaped judgement" split used by
// extractProductDraft.js:
//
//   1. detectCategory() (regex, deterministic) narrows the candidate set to
//      one product family (e.g. "pressure_transmitter") so a pressure
//      enquiry is never scored against temperature/level products.
//   2. The LLM reads the enquiry text + the full spec sheet of every
//      candidate IN THAT FAMILY (fetched live from the products table, which
//      is populated only from admin-published catalogue uploads — never
//      hardcoded) and returns a ranked, scored, reasoned match.
//
// If Ollama is unreachable, falls back to a deterministic scorer so the
// feature degrades instead of hard-failing.

const db = require('../config/db');
const { extractStructured } = require('./llmClient');
const { parseEnquiryText, detectCategory } = require('./parseEnquiryText');

const matchSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          product_id: { type: 'string', description: 'Must be one of the candidate product ids given to you, exactly as written.' },
          percent: { type: 'number', description: 'Overall match score 0-100.' },
          band: { type: 'string', enum: ['strong', 'workable', 'weak'] },
          matching_specs: { type: 'array', items: { type: 'string' }, description: 'Short phrases: which stated requirements this product satisfies.' },
          deviations: { type: 'array', items: { type: 'string' }, description: 'Short phrases: where this product differs from what was asked (e.g. wider range than needed, no HART).' },
          missing_specs: { type: 'array', items: { type: 'string' }, description: 'Requirements the enquiry stated that this product\'s datasheet does not confirm either way.' },
          reason: { type: 'string', description: 'One sentence on why this product was ranked here.' },
        },
        required: ['product_id', 'percent', 'band', 'reason'],
      },
    },
  },
  required: ['results'],
};

const SYSTEM_PROMPT = `You are a Forbes Marshall sales engineer matching a customer enquiry to the correct instrument model.
You will be given the enquiry text and a JSON list of candidate products from the SAME family (e.g. all pressure transmitters), each with its real datasheet specs.
Score EVERY candidate 0-100 on how well it satisfies the enquiry: range coverage, hazardous area, output type (HART/4-20mA/switch/modbus), max temperature, accuracy, and process connection where stated.
A product whose range is far wider than requested is workable but not a perfect fit — prefer a snug match over an oversized one, and note it as a deviation, not a missing spec.
Never invent a product id that is not in the candidate list. If nothing fits well, still return your best-ranked candidates rather than an empty list.
IMPORTANT — deviations must never be left empty when percent < 100: for every attribute where the product's actual spec differs from, or goes beyond, what the enquiry stated, add one short phrase to deviations (e.g. "Range 0-6000mm is far wider than requested", "No HART, output is visual only"). If the enquiry simply didn't state a value for something the product datasheet does specify, put that in missing_specs instead (e.g. "Accuracy not stated by customer — product is ±1% FS"), not deviations. Only use a low percent AND leave deviations sparse when the enquiry itself is too vague to compare against (e.g. contains no technical detail at all) — in that case say so plainly in reason.`;

function buildCandidateSummary(products) {
  return products.map((p) => ({
    id: p.id,
    family: p.family,
    val_min: p.val_min,
    val_max: p.val_max,
    temp_max: p.temp_max,
    accuracy: p.accuracy,
    output_type: p.output_type,
    hazardous: p.hazardous,
    connection: p.connection,
    blurb: p.blurb,
  }));
}

// Deterministic fallback if the LLM is unreachable — never blocks the feature.
function fallbackScore(parsed, product) {
  let score = 0.5;
  const notes = { matching: [], deviations: [] };
  if (parsed.range && product.val_max != null) {
    const prodMin = Number(product.val_min);
    const prodMax = Number(product.val_max);
    if (parsed.range.max <= prodMax && parsed.range.min >= prodMin) {
      const span = prodMax - prodMin;
      const tightness = span > 0 ? Math.min(1, (parsed.range.max - parsed.range.min) / span) : 1;
      score = 0.55 + 0.35 * tightness;
      notes.matching.push(`Range covers ${parsed.range.min} to ${parsed.range.max}`);
      if (tightness < 0.2) notes.deviations.push(`Product range (${prodMin} to ${prodMax}) is much wider than requested`);
    } else {
      score = 0.25;
      notes.deviations.push(`Product range (${prodMin} to ${prodMax}) does not cover requested ${parsed.range.min} to ${parsed.range.max}`);
    }
  }
  if (parsed.hazardous && product.hazardous) {
    if (parsed.hazardous === product.hazardous || product.hazardous === 'both') {
      score += 0.1;
      notes.matching.push(`Area classification (${product.hazardous}) matches`);
    } else {
      score -= 0.15;
      notes.deviations.push(`Enquiry needs ${parsed.hazardous}, product is ${product.hazardous}`);
    }
  }
  if (parsed.outputCandidates.length && product.output_type) {
    if (parsed.outputCandidates.includes(product.output_type)) {
      score += 0.1;
      notes.matching.push(`Output (${product.output_type}) matches`);
    }
  }
  return { percent: Math.round(Math.max(0, Math.min(1, score)) * 100), notes };
}

async function runFallback(parsed, products) {
  return products
    .map((p) => {
      const { percent, notes } = fallbackScore(parsed, p);
      return {
        product: p,
        percent,
        band: percent >= 75 ? 'strong' : percent >= 50 ? 'workable' : 'weak',
        matchingSpecs: notes.matching,
        deviations: notes.deviations,
        missingSpecs: [],
        reason: 'Scored by deterministic fallback (LLM unavailable).',
      };
    })
    .sort((a, b) => b.percent - a.percent);
}

/**
 * @param {string} text - raw enquiry text
 * @param {{ attachmentNames?: string[] }} [opts] - filenames of any attached
 *   files. Their names alone (not contents — that extraction isn't built
 *   yet) are appended to the category-detection pass, since a filename like
 *   "GPPE Pressure transmitter.xlsx" is often a strong hint even when the
 *   typed message itself ("prepare an offer") has no product details.
 * @returns {Promise<{ categoryId: string|null, parsed: object, results: object[], provider: string }>}
 */
async function matchEnquiry(text, { attachmentNames = [] } = {}) {
  const { rows: categories } = await db.query('SELECT * FROM categories ORDER BY label');
  const detectionText = [text, ...attachmentNames].join(' ');
  const categoryId = detectCategory(detectionText, categories);
  const parsed = parseEnquiryText(text);

  // With no identifiable product family, don't fall back to scoring the
  // ENTIRE catalogue against the LLM — that's slow (a big prompt on a local
  // CPU model) and the results are meaningless anyway (cross-category
  // matches). Ask for a specific product type instead; this responds
  // instantly.
  if (!categoryId) {
    return {
      categoryId: null,
      parsed,
      results: [],
      provider: 'none',
      warning: 'Could not identify a product family from this enquiry. Please mention the product type explicitly (e.g. "pressure transmitter", "temperature switch") — attachment contents aren\'t read yet, only typed text and file names.',
    };
  }

  const candidateSql = `
    SELECT p.*, c.label AS category_label,
      EXISTS(
        SELECT 1 FROM product_catalogue_files f
        WHERE f.product_id = p.id AND f.is_current = TRUE
      ) AS has_catalogue
    FROM products p JOIN categories c ON c.id = p.category_id
    WHERE p.category_id = $1
    ORDER BY p.family, p.id`;
  const { rows: candidates } = await db.query(candidateSql, [categoryId]);

  // Category detected, but nothing published under it yet.
  if (candidates.length === 0) {
    return { categoryId, parsed, results: [], provider: 'none', warning: 'No products found for this enquiry\'s category. Check the admin console has published catalogue entries for this product family.' };
  }

  let llmResults;
  let provider;
  try {
    const userText = `Enquiry:\n${text}\n\nCandidate products (JSON):\n${JSON.stringify(buildCandidateSummary(candidates))}`;
    const { data, model } = await extractStructured(SYSTEM_PROMPT, userText, matchSchema);
    if (!data.results || !Array.isArray(data.results) || data.results.length === 0) {
      throw new Error('LLM returned no results');
    }
    provider = `local-ollama-${model}`;
    const byId = new Map(candidates.map((p) => [p.id, p]));
    llmResults = data.results
      .filter((r) => byId.has(r.product_id))
      .map((r) => ({
        product: byId.get(r.product_id),
        percent: Math.max(0, Math.min(100, Math.round(r.percent))),
        band: r.band || (r.percent >= 75 ? 'strong' : r.percent >= 50 ? 'workable' : 'weak'),
        matchingSpecs: r.matching_specs || [],
        deviations: r.deviations || [],
        missingSpecs: r.missing_specs || [],
        reason: r.reason || '',
      }))
      .sort((a, b) => b.percent - a.percent);
    if (llmResults.length === 0) throw new Error('LLM returned only unknown product ids');
  } catch (err) {
    console.error('LLM matching failed, using deterministic fallback:', err.message);
    llmResults = await runFallback(parsed, candidates);
    provider = 'fallback-deterministic';
  }

  return { categoryId, parsed, results: llmResults, provider };
}

module.exports = { matchEnquiry };
