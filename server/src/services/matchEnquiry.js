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
//      structured fields OR extra specs confirm, internalDatasheetLookup.js
//      searches that SAME candidate's own published datasheet TEXT (via
//      Postgres full-text search — no internet, no vector DB) and, if
//      found, extracts it via an LLM call strictly grounded in that
//      excerpt. If nothing is found there either, the spec is reported as
//      missing, never guessed. Internal data only, always — this app never
//      calls out to the internet.
//   4. Separately, computeClarificationsNeeded() flags parameters the
//      ENQUIRY itself left unstated where the top candidates still
//      genuinely differ — i.e. exactly the information a sales engineer
//      would need to ask the customer for before the match can be
//      finalized to one specific model, not just "the catalogue doesn't
//      say."
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
const { parseInstrumentTag, tagHintLine } = require('./parseInstrumentTag');
const { parseEnquiryText, detectCategory } = require('./parseEnquiryText');
const { parseEnquiryFile, isExcelFile, isPdfFile } = require('./enquiryFileParser');
const { splitEnquiryText } = require('./splitEnquiries');
const { classifyCategory } = require('./categoryClassifier');
const { lookupSpecInDatasheet } = require('./internalDatasheetLookup');

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
You will be given the enquiry text and a JSON list of candidate products from the SAME family (e.g. all pressure transmitters, or all RTDs, or all process indicators), each with its real datasheet specs. This candidate list is the ONLY source of truth about the products — it comes directly from Forbes Marshall's published catalogue.
Score EVERY candidate 0-100 on how well it satisfies the enquiry, using WHICHEVER of the following the candidate JSON actually has values for: range coverage, hazardous area, output type (HART/4-20mA/switch/modbus/visual), max temperature, accuracy, process connection, and the "extra_specs" list — this last one is where family-specific attributes live (e.g. an RTD's wiring/element type, a switch's differential/contact rating, a level instrument's measurement principle, an indicator's power/display type). Treat extra_specs entries with the same weight as the fixed fields when the enquiry mentions that attribute.
A product whose range is far wider than requested is workable but not a perfect fit — prefer a snug match over an oversized one, and note it as a deviation, not a missing spec.
Never invent a product id that is not in the candidate list. Never invent, guess, or round a numeric spec value that is not present in the candidate JSON — if a candidate's field is null/absent and doesn't appear in its extra_specs either, treat that attribute as unconfirmed (missing_specs), not as a value you can supply yourself.
If nothing fits well, still return your best-ranked candidates rather than an empty list.
IMPORTANT — deviations must never be left empty when percent < 100: for every attribute where the product's actual spec differs from, or goes beyond, what the enquiry stated, add one short phrase to deviations (e.g. "Range 0-6000mm is far wider than requested", "No HART, output is visual only", "3-wire only, enquiry asked for 4-wire"). If the enquiry simply didn't state a value for something the product datasheet does specify, put that in missing_specs instead (e.g. "Accuracy not stated by customer — product is ±1% FS"), not deviations. Only use a low percent AND leave deviations sparse when the enquiry itself is too vague to compare against (e.g. contains no technical detail at all) — in that case say so plainly in reason.`;

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
    extra_specs: (p.extra_specs || []).map((s) => `${s.label}: ${s.value}`),
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
 * candidate's structured fields OR extra_specs confirm), search that SAME
 * candidate's own published datasheet TEXT — internal only, no internet.
 * Never called for anything the structured data already answered.
 */
async function enrichMissingSpecsFromDatasheet(result, categoryLabel) {
  const sources = [];
  if (!result.missingSpecs || result.missingSpecs.length === 0 || !result.product.has_catalogue) {
    return { datasheetFindings: [], sources };
  }

  const datasheetFindings = [];
  for (const spec of result.missingSpecs) {
    const question = `For the Forbes Marshall ${result.product.model} (${categoryLabel || result.product.family}): ${spec}`;
    try {
      const found = await lookupSpecInDatasheet(result.product.id, question);
      if (found.found && found.value && found.source) {
        datasheetFindings.push({ spec, value: found.value, source: found.source });
        sources.push({ type: 'catalogue_excerpt', productId: found.source.productId, excerpt: found.source.excerpt });
      }
    } catch (err) {
      console.error('Datasheet enrichment failed for spec:', spec, err.message);
    }
  }
  return { datasheetFindings, sources };
}

/**
 * Flags parameters the ENQUIRY itself left unstated where the top
 * candidates still genuinely disagree — i.e. information a sales engineer
 * needs from the customer before the match can be narrowed to one exact
 * model, as distinct from missingSpecs (which is about the CATALOGUE
 * lacking data). Purely deterministic: compares real candidate values,
 * flags a gap only when they actually differ. Never invents a value or a
 * question — if every top candidate agrees, there's nothing to ask.
 */
function computeClarificationsNeeded(parsed, results) {
  const top = results.slice(0, 3).filter((r) => r.product);
  if (top.length < 2) return [];

  const rawTextLower = (parsed.rawText || '').toLowerCase();
  const clarifications = [];

  const fixedDims = [
    { label: 'Area classification (safe / flameproof / both)', specified: !!parsed.hazardous, get: (p) => p.hazardous },
    { label: 'Output type', specified: parsed.outputCandidates.length > 0, get: (p) => p.output_type },
    { label: 'Process connection', specified: /\b(npt|bsp|flange|thread|connection)\b/.test(rawTextLower), get: (p) => p.connection },
    { label: 'Accuracy requirement', specified: /\b(accuracy|±|\+\/-|class\s?[a-b0-9])\b/.test(rawTextLower), get: (p) => p.accuracy },
  ];
  for (const dim of fixedDims) {
    if (dim.specified) continue;
    const distinctValues = [...new Set(top.map((r) => dim.get(r.product)).filter(Boolean))];
    if (distinctValues.length > 1) {
      clarifications.push({ parameter: dim.label, candidateValues: distinctValues });
    }
  }

  // Family-specific attributes (product_extra_spec) — union of labels
  // across the top candidates, same "differ + enquiry silent on it" test.
  const labelSet = new Set();
  top.forEach((r) => (r.product.extra_specs || []).forEach((s) => labelSet.add(s.label)));
  for (const label of labelSet) {
    if (rawTextLower.includes(label.toLowerCase())) continue; // enquiry did mention this attribute by name
    const distinctValues = [...new Set(
      top.map((r) => (r.product.extra_specs || []).find((s) => s.label === label)?.value).filter(Boolean)
    )];
    if (distinctValues.length > 1) {
      clarifications.push({ parameter: label, candidateValues: distinctValues });
    }
  }

  return clarifications;
}

/**
 * Runs the full match pipeline for ONE enquiry's text.
 * @param {string} text - raw enquiry text for this single item
 * @param {{ attachmentNames?: string[], sourceExcerpt?: string, enrichFromDatasheet?: boolean }} [opts]
 */
async function matchSingleEnquiry(text, { attachmentNames = [], enrichFromDatasheet = true } = {}) {
  const { rows: categories } = await db.query('SELECT * FROM categories ORDER BY label');
  const detectionText = [text, ...attachmentNames].join(' ');
  const parsed = parseEnquiryText(text);

  // Deterministic alias/label matching first (instant, exact); only if that
  // finds nothing does an LLM classification step run, constrained to this
  // exact category list so it can never invent a family that doesn't exist.
  let categoryId = detectCategory(detectionText, categories);
  let categorySource = categoryId ? 'alias' : null;
  if (!categoryId) {
    categoryId = await classifyCategory(detectionText, categories);
    if (categoryId) categorySource = 'llm';
  }

  if (!categoryId) {
    return {
      text,
      categoryId: null,
      parsed,
      results: [],
      provider: 'none',
      warning: 'Could not identify a product family from this enquiry. Please mention the product type explicitly (e.g. "pressure transmitter", "RTD", "process indicator").',
    };
  }

  const categoryLabel = categories.find((c) => c.id === categoryId)?.label || null;

  const candidateSql = `
    SELECT p.*, c.label AS category_label,
      EXISTS(
        SELECT 1 FROM product_catalogue_files f
        WHERE f.product_id = p.id AND f.is_current = TRUE
      ) AS has_catalogue,
      COALESCE(
        (SELECT json_agg(json_build_object('label', es.label, 'value', es.value) ORDER BY es.label)
         FROM product_extra_spec es WHERE es.product_id = p.id),
        '[]'
      ) AS extra_specs
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

  // Attach requested-vs-actual + sources (catalogue link always; datasheet
  // text search only for the top few candidates and only when something is
  // genuinely unconfirmed — running this for every candidate would be slow
  // and mostly wasted).
  const DATASHEET_ENRICH_TOP_N = 3;
  for (let i = 0; i < llmResults.length; i++) {
    const r = llmResults[i];
    r.requestedVsActual = buildRequestedVsActual(parsed, r.product);
    r.sources = [];
    if (r.product.has_catalogue) {
      r.sources.push({ type: 'catalogue', productId: r.product.id, label: `${r.product.model} — published datasheet` });
    }
    if (enrichFromDatasheet && i < DATASHEET_ENRICH_TOP_N) {
      const { datasheetFindings, sources: datasheetSources } = await enrichMissingSpecsFromDatasheet(r, categoryLabel);
      r.datasheetFindings = datasheetFindings;
      r.sources.push(...datasheetSources);
    } else {
      r.datasheetFindings = [];
    }
  }

  const clarificationsNeeded = computeClarificationsNeeded(parsed, llmResults);

  return { text, categoryId, categorySource, parsed, results: llmResults, provider, clarificationsNeeded };
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

  if (file && (isExcelFile(file) || isPdfFile(file))) {
    const parsed = await parseEnquiryFile(file);
    if (parsed.warning) fileWarning = parsed.warning;

    if (parsed.kind === 'excel') {
      rawItems = (parsed.blocks || []).map((b) => ({
        text: (text && text.trim() ? `${text.trim()}\n\n` : '') + b.text,
        sourceExcerpt: b.text.slice(0, 240),
        sourceRef: `${file.originalname} — ${b.rowRange}`,
        known: b.known || null,
        tagHint: tagHintLine(b.known && b.known.tagNo),
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
    // A file was attached but isn't one we can read. Previously this branch
    // ran silently: the upload was dropped, the typed text was matched, and
    // the response looked completely normal — the user saw results that never
    // touched their spreadsheet.
    if (file) {
      fileWarning = `"${file.originalname}" wasn't read — it arrived as "${file.mimetype || 'no type'}", ` +
        `and only PDF and Excel (.xlsx/.xls) content is parsed. Matching used only the text you typed.`;
    }
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
    // Append the tag interpretation BEFORE matching, so the category
    // classifier sees it too. Routing a DPT into the plain pressure-transmitter
    // family is a candidate-SELECTION error; by scoring time it is already too
    // late, because the right product was never in the shortlist.
    const enquiryText = raw.tagHint ? `${raw.text}\n${raw.tagHint}` : raw.text;
    const matched = await matchSingleEnquiry(enquiryText, { attachmentNames });
    // Tag/qty/MOC read straight off labelled spreadsheet columns beat anything
    // the LLM inferred from prose — they are exact. Override, don't merge.
    if (raw.known) {
      matched.parsed = { ...(matched.parsed || {}) };
      if (raw.known.tagNo) matched.parsed.tagNo = raw.known.tagNo;
      if (raw.known.qty != null) matched.parsed.qty = raw.known.qty;
      if (raw.known.moc) matched.parsed.moc = raw.known.moc;
      if (raw.known.connection) matched.parsed.connectionRaw = raw.known.connection;
      const tag = parseInstrumentTag(raw.known.tagNo);
      if (tag) {
        matched.parsed.instrumentType = tag.label;
        matched.parsed.differential = tag.differential;
        matched.parsed.tagCategoryHint = tag.categoryHint;
        matched.parsed.outOfScope = tag.outOfScope || false;
      }
    }
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
