// server/src/controllers/offersController.js
const db = require('../config/db');
const { hasTemplate, listPlaceholders, renderOffer, autoFillFromProduct, matchExtraSpecsToTags } = require('../services/generateOffer');

async function getExtraSpecs(productId) {
  const { rows } = await db.query('SELECT label, value FROM product_extra_spec WHERE product_id = $1', [productId]);
  return rows;
}

// GET /offers/fields/:productId
// Tells the frontend exactly which fields this product's category template
// needs, split into what we can already auto-fill (from the base catalogue
// record AND any admin-captured extra specs) vs what the sales engineer
// must still supply by hand. Nothing hardcoded per category — the field
// list comes from reading the actual template file.
async function getFields(req, res) {
  const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [req.params.productId]);
  const product = rows[0];
  if (!product) return res.status(404).json({ error: 'Product not found' });

  if (!hasTemplate(product.category_id)) {
    return res.status(404).json({
      error: `No offer template uploaded yet for category "${product.category_id}".`,
      categoryId: product.category_id,
    });
  }

  const allFields = listPlaceholders(product.category_id);
  const baseAutoFilled = autoFillFromProduct(product, {});
  const extraSpecs = await getExtraSpecs(product.id);
  const extraFilled = matchExtraSpecsToTags(allFields, extraSpecs);
  const autoFilled = { ...baseAutoFilled, ...extraFilled };
  const manualFields = allFields.filter((f) => !(f in autoFilled));

  res.json({ categoryId: product.category_id, autoFilled, manualFields });
}

// POST /offers/generate   { productId, customerName, date, qty, fields: {...manual values...} }
async function generate(req, res) {
  const { productId, customerName, date, qty, fields } = req.body;
  const { rows } = await db.query('SELECT * FROM products WHERE id = $1', [productId]);
  const product = rows[0];
  if (!product) return res.status(404).json({ error: 'Product not found' });

  if (!hasTemplate(product.category_id)) {
    return res.status(404).json({ error: `No offer template uploaded yet for category "${product.category_id}".` });
  }

  const allFields = listPlaceholders(product.category_id);
  const extraSpecs = await getExtraSpecs(product.id);
  const extraFilled = matchExtraSpecsToTags(allFields, extraSpecs);
  const data = { ...autoFillFromProduct(product, { customerName, date, qty }), ...extraFilled, ...(fields || {}) };
  const buffer = renderOffer(product.category_id, data);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="Offer_${product.model || product.id}.docx"`);
  res.send(buffer);
}

module.exports = { getFields, generate };
