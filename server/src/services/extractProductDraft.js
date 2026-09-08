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
Read the text and fill each field ONLY if the text states it — leave a field null rather than guessing.
Never invent a numeric value. "family" and "blurb" should be in your own words; everything else should be read directly from the text.`;

const MAX_CHARS = 6000; // datasheets front-load spec info; truncate to keep the prompt small for a 1B model

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
    extra_specs: (data.extra_specs && data.extra_specs.length) ? 0.5 : 0.2,
  };

  // "Label: Value" strings -> {label, value} pairs, for product_extra_spec.
  // Dropped (not silently kept malformed) if a line doesn't have the colon —
  // better to lose one attribute than store garbage the admin didn't see.
  const extraSpecs = (data.extra_specs || [])
    .map((line) => {
      const idx = String(line).indexOf(':');
      if (idx < 0) return null;
      const label = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      return label && value ? { label, value } : null;
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