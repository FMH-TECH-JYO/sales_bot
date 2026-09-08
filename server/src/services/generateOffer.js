// server/src/services/generateOffer.js
//
// Fills an existing offer .docx template's {{placeholder}} tags with real
// data — never touches layout, fonts, tables, branding, or structure.
// One template file per product category lives in server/templates/offers/
// (e.g. pressure_gauge.docx). This is intentionally scalable: adding a new
// product family's offer format means dropping in a new template file, not
// writing new code — the placeholder names are read from the template
// itself, never hardcoded here.

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates', 'offers');

// A single company-wide offer template used for EVERY category/model, unless
// a category-specific override file exists. pressure_gauge.docx carries the
// SP placeholder set ({{model1}}, {{range1}}, {{dialsize1}}, ... — the same
// 23 tags as "placeholders of SP.docx") and is treated as that common
// template, so every match (SP, LT, GC, any published product) generates an
// offer in this same format instead of hitting "No offer template uploaded".
const COMMON_TEMPLATE_FILE = 'pressure_gauge.docx';

function templatePathFor(categoryId) {
  const perCategory = path.join(TEMPLATES_DIR, `${categoryId}.docx`);
  if (fs.existsSync(perCategory)) return perCategory;
  return path.join(TEMPLATES_DIR, COMMON_TEMPLATE_FILE);
}

function hasTemplate(categoryId) {
  // Always true as long as the common template file is present — categories
  // fall back to it, so "no template" only happens if that file is deleted.
  return fs.existsSync(templatePathFor(categoryId));
}

function loadDoc(categoryId) {
  const templatePath = templatePathFor(categoryId);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`No offer template found — expected the common template at server/templates/offers/${COMMON_TEMPLATE_FILE} (or a category-specific server/templates/offers/${categoryId}.docx).`);
  }
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  return new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, delimiters: { start: '{{', end: '}}' } });
}

/**
 * Reads a template and returns every {{tag}} name it contains, in document
 * order, deduplicated. Used so the frontend can build a form of exactly the
 * fields this specific category's template needs — nothing hardcoded.
 */
function listPlaceholders(categoryId) {
  const doc = loadDoc(categoryId);
  const fullText = doc.getFullText();
  const seen = new Set();
  const tags = [];
  const re = /\{\{(\w+)\}\}/g;
  let m;
  while ((m = re.exec(fullText)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); tags.push(m[1]); }
  }
  return tags;
}

/**
 * @param {string} categoryId - e.g. "pressure_gauge"
 * @param {Record<string,string>} data - flat map of placeholder name -> value.
 *   Any tag not present in `data` renders as an empty string rather than
 *   throwing, so a partially-filled offer is still usable.
 * @returns {Buffer} the generated .docx file
 */
function renderOffer(categoryId, data) {
  const doc = loadDoc(categoryId);
  const safeData = new Proxy(data, { get: (t, k) => (k in t ? t[k] : '') });
  doc.render(safeData);
  return doc.getZip().generate({ type: 'nodebuffer' });
}

/**
 * Builds the auto-fillable subset of placeholder values straight from a
 * matched product + the enquiry, using the naming convention seen in the
 * pressure_gauge template (fields ending in "1" for the first line item —
 * model1, range1, accuracy1, connection1, process_temperature1, qty1).
 * Fields the product record has no data for (dial size, bourdon & socket,
 * case & bezel, movement, mounting, pointer, blow-out disc, gasket,
 * certification, reference standard, over-pressure limit, case filling,
 * window, ambient temperature) are intentionally left out here — those
 * come from the sales engineer via the Offer page form, since the current
 * catalogue schema doesn't capture them and guessing would be worse than
 * asking.
 */
function autoFillFromProduct(product, { customerName, date, qty } = {}) {
  return {
    date: date || new Date().toLocaleDateString('en-GB'),
    customer_name: customerName || '',
    model1: product.model || product.id || '',
    range1: product.val_min != null && product.val_max != null ? `${product.val_min} to ${product.val_max}` : '',
    accuracy1: product.accuracy || '',
    connection1: product.connection || '',
    process_temperature1: product.temp_max != null ? `Up to ${product.temp_max}°C` : '',
    qty1: qty != null ? String(qty) : '1',
  };
}

function normalizeTag(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
}

/**
 * Matches a template's numbered placeholder tags (e.g. "dialsize1",
 * "bourdon_socket1") against a product's product_extra_spec rows (arbitrary
 * label/value pairs captured during catalogue upload, e.g. "Dial Size" ->
 * "100mm"), by normalizing both to bare alphanumerics and comparing. This
 * lets an admin-uploaded datasheet auto-fill the offer template instead of
 * the sales engineer retyping specs that are already in the catalogue.
 * @returns {Record<string,string>} matched tag -> value
 */
function matchExtraSpecsToTags(tags, extraSpecRows) {
  const bySlug = new Map(extraSpecRows.map((r) => [normalizeTag(r.label), r.value]));
  const result = {};
  for (const tag of tags) {
    const slug = normalizeTag(tag);
    if (bySlug.has(slug)) result[tag] = bySlug.get(slug);
  }
  return result;
}

module.exports = { hasTemplate, listPlaceholders, renderOffer, autoFillFromProduct, matchExtraSpecsToTags, templatePathFor };