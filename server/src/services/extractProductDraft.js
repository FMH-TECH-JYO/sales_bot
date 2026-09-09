// server/src/services/extractProductDraft.js
//
// Called once per catalogue upload, right after PDF text extraction.
// Produces the extracted_json + confidence_json that pre-fills the review
// screen — this is what turns "admin hand-types every field" (Phase 2) into
// "admin reviews and corrects a draft" (Phase 3).

const { extractStructured } = require('./llmClient');
const { productDraftSchema } = require('./productDraftSchema');
const { preprocess, crossValidateHazard, crossValidateOutput } = require('./preprocess');

const SYSTEM_PROMPT = `You are extracting structured product data from a Forbes Marshall industrial instrument datasheet.

Two jobs, and the second one is the bigger one:

1. Fill the fixed fields (range, temperature, output, hazardous area, connection).
   These drive product MATCHING. Fill each ONLY if the text states it — leave it
   null rather than guessing. Never invent a numeric value.

2. Transcribe the product's COMPLETE specification table into extra_specs, in the
   order the datasheet prints it. This is copied straight into the customer's
   techno-commercial offer, so completeness matters more than judgement about
   what is important: a real offer for a single pressure gauge lists around 28
   rows, including ones that look mundane (Dial, Pointer, Sealing Ring, Blow Out
   Disc, Vent Plug). Missing rows become blanks in a document sent to a customer.
   Do not summarise, do not skip rows, do not merge rows, and do not reword —
   keep the datasheet's own labels and values.

"family" and "blurb" are in your own words. Everything else is read from the text.`;

// Datasheets front-load headline specs, but the full specification TABLE is
// often on page 2 or 3 — beyond 6000 characters on anything but a one-page
// sheet. That old limit was sized for llama3.2:1b, where a long prompt hurt
// quality more than a truncated table did; extracting only what matters for
// matching, it was a reasonable trade. Now that extra_specs has to carry the
// whole table into a customer document, truncating mid-table silently drops
// offer rows. Raised, and made configurable so it can be tuned per model
// without a code change.
const MAX_CHARS = Number(process.env.EXTRACTION_MAX_CHARS) || 24000;

/**
 * @param {string} rawText - from pdfParser.extractText()
 * @param {string|null} categoryLabel - e.g. "Pressure switch (on/off, mechanical)", improves prompt quality if known
 * @returns {Promise<{ extracted: object, confidence: object, provider: string }>}
 */
async function extractProductDraft(rawText, categoryLabel = null) {
  const truncated = rawText.slice(0, MAX_CHARS);
  const userText = categoryLabel
    ? `Product category (already confirmed): ${categoryLabel}\n\nDatasheet text:\n${truncated}`
    : `Datasheet text:\n${truncated}`;

  const pre = preprocess(truncated);

  const { data, model } = await extractStructured(SYSTEM_PROMPT, userText, productDraftSchema);

  const confidence = {
    id: data.id ? 0.6 : 0.2,
    family: data.family ? 0.7 : 0.1,
    blurb: 0.5,
    val_min: pre.rangeCandidates.some(r => r.min === data.val_min) ? 0.9 : (data.val_min != null ? 0.4 : 0.2),
    val_max: pre.rangeCandidates.some(r => r.max === data.val_max) ? 0.9 : (data.val_max != null ? 0.4 : 0.2),
    temp_max: data.temp_max != null ? 0.5 : 0.2,
    hazardous: crossValidateHazard(data.hazardous, pre),
    output_type: crossValidateOutput(data.output_type, pre),
    connection: data.connection ? 0.5 : 0.2,
    industries: data.industries && data.industries.length ? 0.6 : 0.2,
    // A near-empty spec table on a real datasheet almost always means the
    // extraction fell short, not that the product has no specs — surface that
    // as low confidence so the reviewer looks rather than publishing a
    // product that will produce an empty offer table.
    extra_specs: !data.extra_specs?.length ? 0.1
      : data.extra_specs.length < 8 ? 0.3
      : 0.6,
  };

  // "Label: Value" strings -> {label, value} pairs, for product_extra_spec.
  // Dropped (not silently kept malformed) if a line doesn't have the colon —
  // better to lose one attribute than store garbage the admin didn't see.
  // Order is preserved deliberately: it becomes the print order of the offer's
  // specification table. Duplicate labels are dropped rather than collapsed,
  // because product_extra_spec is unique on (product_id, label) and a silent
  // ON CONFLICT overwrite would swap one row's value for another's.
  const seenLabels = new Set();
  const extraSpecs = (data.extra_specs || [])
    .map((line) => {
      const idx = String(line).indexOf(':');
      if (idx < 0) return null;
      const label = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!label || !value) return null;
      const key = label.toLowerCase();
      if (seenLabels.has(key)) return null;
      seenLabels.add(key);
      return { label, value };
    })
    .filter(Boolean);

  return {
    extracted: {
      id: data.id || null,
      model: data.model || data.id || null,
      family: data.family,
      blurb: data.blurb,
      val_min: data.val_min ?? null,
      val_max: data.val_max ?? null,
      temp_max: data.temp_max ?? null,
      accuracy: data.accuracy || null,
      output_type: data.output_type,
      hazardous: data.hazardous,
      connection: data.connection || null,
      industries: data.industries || [],
      extra_specs: extraSpecs,
    },
    confidence,
    provider: `local-ollama-${model}`,
  };
}

module.exports = { extractProductDraft };