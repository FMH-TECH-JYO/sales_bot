// Local, explainable retrieval for catalogue-grounded matching.  This is the
// retrieval half of RAG: it narrows the LLM context to the models whose real
// catalogue terms best match the enquiry. It deliberately has no cloud/API
// dependency and preserves numbers as high-value discriminators.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'need', 'please', 'required', 'requirement', 'make', 'model', 'product', 'instrument', 'to', 'of', 'in', 'at', 'a', 'an']);
const SYNONYMS = { '4ma': '4 20ma', '4-20ma': '4 20ma', 'exd': 'flameproof', 'atex': 'flameproof', 'explosionproof': 'flameproof', 'hygienic': 'sanitary', 'bourdon': 'pressure gauge', 'dp': 'differential pressure' };

function normalize(text = '') {
  let value = String(text).toLowerCase();
  for (const [from, to] of Object.entries(SYNONYMS)) value = value.replaceAll(from, to);
  return value.replace(/([a-z])(?=\d)|(?<=\d)([a-z])/g, '$1 $2').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(text) {
  return normalize(text).split(' ').filter((token) => token.length > 1 && !STOP.has(token));
}

function catalogueText(product) {
  return [product.id, product.model, product.family, product.category_label, product.blurb, product.output_type,
    product.hazardous, product.connection, product.accuracy, product.val_min, product.val_max, product.temp_max,
    ...(product.keywords || []), ...(product.industries || []), JSON.stringify(product.extra_specs || {}),
    JSON.stringify(product.selectable_ranges || []), JSON.stringify(product.order_code || {})].filter(Boolean).join(' ');
}

function scoreProduct(enquiryText, product, detectedCategory) {
  const queryTokens = tokens(enquiryText);
  const docTokens = new Set(tokens(catalogueText(product)));
  let score = 0;
  for (const token of queryTokens) {
    if (docTokens.has(token)) score += /^\d/.test(token) ? 7 : 2;
    else if (token.length >= 5 && [...docTokens].some((candidate) => candidate.startsWith(token) || token.startsWith(candidate))) score += 0.75;
  }
  const family = normalize(`${product.model} ${product.family}`);
  if (family && normalize(enquiryText).includes(family)) score += 16;
  if (detectedCategory && product.category_id === detectedCategory) score += 6;
  return score;
}

function retrieveProducts(enquiryText, products, detectedCategory, limit = 6) {
  return products
    .map((product) => ({ product, retrievalScore: scoreProduct(enquiryText, product, detectedCategory) }))
    .sort((a, b) => b.retrievalScore - a.retrievalScore || String(a.product.id).localeCompare(String(b.product.id)))
    .slice(0, Math.min(limit, products.length));
}

module.exports = { retrieveProducts, catalogueText, normalize };
