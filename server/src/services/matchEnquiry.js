// server/src/services/matchEnquiry.js
//
// Turns one or more free-text enquiries into ranked lists of real catalogue
// products. Same "classical text processing for the deterministic parts,
// LLM for the language-shaped judgement" split used elsewhere:
//
//   1. detectCategory() (regex, deterministic) narrows the candidate set to
//      one product family (e.g. "pressure_transmitter") so a pressure
//      enquiry is never scored against temperature/level products.
//   2. The LLM reads the enquiry text + the full spec sheet of every
//      candidate IN THAT FAMILY (fetched live from the products table, which
//      is populated only from admin-published catalogue uploads — never
//      hardcoded, and never made up by the model) and returns a ranked,
//      scored, reasoned match. INTERNAL CATALOGUES ARE ALWAYS THE FIRST AND
//      PRIMARY SOURCE.
//   3. Only for specs the enquiry explicitly asked about that NO candidate's
//      catalogue data confirms either way, an optional web lookup
//      (webLookup.js) is attempted — grounded strictly in retrieved
//      snippets, never the model's own trained knowledge. If web lookup is
//      unavailable or turns up nothing, the spec is reported as missing,
//      never guessed.
//
// A single document (Excel/PDF/typed text) can describe MULTIPLE product
// enquiries. matchEnquiries() splits it (enquiryFileParser.js for
// spreadsheets, splitEnquiries.js for prose/PDF text) and runs the full
// pipeline once per item, so N stated enquiries produce N independent
// match results.
//
// If Ollama is unreachable, falls back to a deterministic scorer so the
// feature degrades instead of hard-failing.

const db = require('../config/db');
const { extractStructured } = require('./llmClient');
const { parseEnquiryText, detectCategory } = require('./parseEnquiryText');
const { parseEnquiryFile, isExcelMime, isPdfMime } = require('./enquiryFileParser');
const { splitEnquiryText } = require('./splitEnquiries');
const webLookup = require('./webLookup');

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
You will be given the enquiry text and a JSON list of candidate products from the SAME family (e.g. all pressure transmitters), each with its real datasheet specs. This candidate list is the ONLY source of truth about the products — it comes directly from Forbes Marshall's published catalogue.
Score EVERY candidate 0-100 on how well it satisfies the enquiry: range coverage, hazardous area, output type (HART/4-20mA/switch/modbus), max temperature, accuracy, and process connection where stated.
A product whose range is far wider than requested is workable but not a perfect fit — prefer a snug match over an oversized one, and note it as a deviation, not a missing spec.
Never invent a product id that is not in the candidate list. Never invent, guess, or round a numeric spec value that is not present in the candidate JSON — if a candidate's field is null/absent, treat that attribute as unconfirmed (missing_specs), not as a value you can supply yourself.
If nothing fits well, still return your best-ranked candidates rather than an empty list.
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

/** Structured requested-vs-actual table, built deterministically from the
 * regex-parsed enquiry and the candidate's real catalogue fields — this is
 * the exact-value comparison the UI shows alongside the LLM's free-text
 * matching/deviation/missing lists. Never touches the LLM, so it can't drift
 * from what's actually in the database. */
function buildRequestedVsActual(parsed, product) {
  const rows = [];
  rows.push({
    parameter: 'Range',
    requested: parsed.range ? `${parsed.range.min} to ${parsed.range.max}` : null,
    actual: (product.val_min != null && product.val_max != null) ? `${product.val_min} to ${product.val_max}` : null,
  });
  rows.push({
    parameter: 'Max temperature',
    requested: parsed.tempMax != null ? `${parsed.tempMax}°C` : null,
    actual: product.temp_max != null ? `${product.temp_max}°C` : null,
  });
  rows.push({
    parameter: 'Area classification',
    requested: parsed.hazardous || null,
    actual: product.hazardous || null,
  });
  rows.push({
    parameter: 'Output type',
    requested: parsed.outputCandidates.length ? parsed.outputCandidates.join(', ') : null,
    actual: product.output_type || null,
  });
  rows.push({ parameter: 'Accuracy', requested: null, actual: product.accuracy || null });
  rows.push({ parameter: 'Process connection', requested: null, actual: product.connection || null });

  return rows.map((r) => {
    let status;
    if (r.requested == null && r.actual == null) status = 'unspecified';
    else if (r.requested == null) status = 'not_requested';
    else if (r.actual == null) status = 'missing';
    else status = String(r.requested).toLowerCase() === String(r.actual).toLowerCase() ? 'match' : 'compare';
    return { ...r, status };
  }).filter((r) => r.status !== 'unspecified');
}

/**
 * For missing_specs the LLM flagged (an enquiry-stated requirement no
 * candidate's catalogue entry confirms), try the internet — strictly
 * grounded, strictly optional. Never called for anything the catalogue
 * already answered.
 */
async function enrichMissingSpecsWithWeb(result, categoryLabel) {
  const sources = [];
  if (!result.missingSpecs || result.missingSpecs.length === 0) {
    return { webFindings: [], sources };
  }
  if (!webLookup.isEnabled()) {
    return {
      webFindings: [],
      sources,
      webLookupNote: 'Internet lookup is not configured (no WEB_SEARCH_PROVIDER/API key set) — these fields are reported as missing rather than guessed.',
    };
  }

  const webFindings = [];
  for (const spec of result.missingSpecs) {
    const question = `For the Forbes Marshall ${result.product.model} (${categoryLabel || result.product.family}): ${spec}`;
    try {
      const found = await webLookup.lookupSpec(question);
      if (found.found && found.value && found.source) {
        webFindings.push({ spec, value: found.value, source: found.source });
        sources.push({ type: 'web', url: found.source.url, title: found.source.title });
      }
    } catch (err) {
      console.error('Web enrichment failed for spec:', spec, err.message);
    }
  }
  return { webFindings, sources };
}

/**
 * Runs the full match pipeline for ONE enquiry's text.
 * @param {string} text - raw enquiry text for this single item
 * @param {{ attachmentNames?: string[], sourceExcerpt?: string, enrichWithWeb?: boolean }} [opts]
 */
async function matchSingleEnquiry(text, { attachmentNames = [], enrichWithWeb = true } = {}) {
  const { rows: categories } = await db.query('SELECT * FROM categories ORDER BY label');
  const detectionText = [text, ...attachmentNames].join(' ');
  const categoryId = detectCategory(detectionText, categories);
  const parsed = parseEnquiryText(text);

  if (!categoryId) {
    return {
      text,
      categoryId: null,
      parsed,
      results: [],
      provider: 'none',
      warning: 'Could not identify a product family from this enquiry. Please mention the product type explicitly (e.g. "pressure transmitter", "temperature switch").',
    };
  }

  const categoryLabel = categories.find((c) => c.id === categoryId)?.label || null;

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

  if (candidates.length === 0) {
    return { text, categoryId, parsed, results: [], provider: 'none', warning: 'No products found for this enquiry\'s category. Check the admin console has published catalogue entries for this product family.' };
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

  // Attach requested-vs-actual + sources (catalogue always; web only for the
  // top few candidates and only when something is genuinely unconfirmed —
  // running this for every candidate would be slow and mostly wasted).
  const WEB_ENRICH_TOP_N = 3;
  for (let i = 0; i < llmResults.length; i++) {
    const r = llmResults[i];
    r.requestedVsActual = buildRequestedVsActual(parsed, r.product);
    r.sources = [];
    if (r.product.has_catalogue) {
      r.sources.push({ type: 'catalogue', productId: r.product.id, label: `${r.product.model} — published datasheet` });
    }
    if (enrichWithWeb && i < WEB_ENRICH_TOP_N) {
      const { webFindings, sources: webSources, webLookupNote } = await enrichMissingSpecsWithWeb(r, categoryLabel);
      r.webFindings = webFindings;
      r.sources.push(...webSources);
      if (webLookupNote) r.webLookupNote = webLookupNote;
    } else {
      r.webFindings = [];
    }
  }

  return { text, categoryId, parsed, results: llmResults, provider };
}

/**
 * Backward-compatible single-enquiry entry point (existing callers/tests).
 */
async function matchEnquiry(text, opts = {}) {
  return matchSingleEnquiry(text, opts);
}

/**
 * Splits raw input (typed text and/or an uploaded Excel/PDF file) into
 * however many product enquiries it actually contains, then runs the full
 * match pipeline independently for each one.
 *
 * @param {string} text - typed message, may be empty if a file was attached
 * @param {{ file?: { buffer: Buffer, mimetype: string, originalname: string }, attachmentNames?: string[] }} [opts]
 * @returns {Promise<{ items: object[], itemCount: number, splitMethod: string, fileWarning?: string }>}
 */
async function matchEnquiries(text, { file, attachmentNames = [] } = {}) {
  let rawItems = []; // [{ text, sourceExcerpt }]
  let splitMethod = 'single';
  let fileWarning;

  if (file && (isExcelMime(file.mimetype) || isPdfMime(file.mimetype))) {
    const parsed = await parseEnquiryFile(file);
    if (parsed.warning) fileWarning = parsed.warning;

    if (parsed.kind === 'excel') {
      rawItems = (parsed.blocks || []).map((b) => ({
        text: (text && text.trim() ? `${text.trim()}\n\n` : '') + b.text,
        sourceExcerpt: b.text.slice(0, 240),
        sourceRef: `${file.originalname} — ${b.rowRange}`,
      }));
      splitMethod = 'excel_rows';
    } else if (parsed.kind === 'pdf') {
      const fileText = parsed.text || '';
      const combinedText = (text && text.trim() ? `${text.trim()}\n\n${fileText}` : fileText);
      const { items, method } = await splitEnquiryText(combinedText);
      rawItems = items.map((t) => ({ text: t, sourceExcerpt: t.slice(0, 240), sourceRef: file.originalname }));
      splitMethod = method;
    }
  } else {
    const { items, method } = await splitEnquiryText(text || '');
    rawItems = items.map((t) => ({ text: t, sourceExcerpt: t.slice(0, 240), sourceRef: 'typed message' }));
    splitMethod = method;
  }

  if (rawItems.length === 0) {
    return { items: [], itemCount: 0, splitMethod, fileWarning };
  }

  // Sequential, not Promise.all: matching goes through a single local LLM
  // (Ollama) instance with no request queue of its own — concurrent calls
  // would either fail or silently serialize anyway, so do it predictably
  // and keep memory bounded for large uploads.
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const matched = await matchSingleEnquiry(raw.text, { attachmentNames });
    items.push({
      index: i,
      sourceExcerpt: raw.sourceExcerpt,
      sourceRef: raw.sourceRef,
      ...matched,
    });
  }

  return { items, itemCount: items.length, splitMethod, fileWarning };
}

module.exports = { matchEnquiry, matchSingleEnquiry, matchEnquiries };
