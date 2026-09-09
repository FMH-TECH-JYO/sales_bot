// server/src/controllers/offersController.js
const db = require('../config/db');
const { hasTemplate, listPlaceholders, renderOffer, autoFillFromProduct, matchExtraSpecsToTags } = require('../services/generateOffer');
const { priceFor } = require('../services/computePrice');

async function getExtraSpecs(productId) {
  const { rows } = await db.query('SELECT label, value FROM product_extra_spec WHERE product_id = $1 ORDER BY sort_order NULLS LAST, label', [productId]);
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
  const {
    productId, customerName, date, qty, fields,
    // New, all optional so the existing frontend call keeps working unchanged.
    enquiryId = null, lineItemId = null, tagNo = null, rangeCode = null,
    config = {}, discountPct = 0, currency = null, isExport = false, terms = null,
  } = req.body;

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

  // Record the offer. Same non-fatal stance as enquiry persistence: the
  // engineer has the document either way, and failing the download because a
  // history INSERT broke would be the wrong trade. Price, specs and discount
  // are SNAPSHOT here — reprinting this offer next year must show what was
  // actually quoted, not what the catalogue says then.
  try {
    await persistOffer({
      enquiryId, lineItemId, product, customerName, qty, tagNo, rangeCode,
      config, discountPct, currency, isExport, terms, extraSpecs, fields,
    });
  } catch (err) {
    console.error('Failed to persist offer (document still delivered):', err);
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="Offer_${product.model || product.id}.docx"`);
  res.send(buffer);
}

/** FM/<year>/<0001>. The sequence avoids a SELECT MAX race between engineers. */
async function nextOfferNo(client) {
  const { rows } = await client.query("SELECT nextval('offer_no_seq') AS n");
  return `FM/${new Date().getFullYear()}/${String(rows[0].n).padStart(4, '0')}`;
}

async function persistOffer({
  enquiryId, lineItemId, product, customerName, qty, tagNo, rangeCode,
  config, discountPct, currency, isExport, terms, extraSpecs, fields,
}) {
  const price = await priceFor(product.id, config, rangeCode);
  const unitPrice = price.unitPrice;              // null when unpriced — see computePrice.js
  const quantity = Number(qty) || 1;

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const offerNo = await nextOfferNo(client);

    const { rows: offerRows } = await client.query(
      `INSERT INTO offers (enquiry_id, offer_no, version, customer_json, terms_json,
                           status, currency, is_export)
       VALUES ($1,$2,1,$3,$4,'generated',$5,$6)
       RETURNING id`,
      [
        enquiryId,
        offerNo,
        JSON.stringify({ customerName: customerName || null, ...(fields?.customer || {}) }),
        JSON.stringify(terms || {}),
        currency || price.currency || 'INR',
        !!isExport,
      ]
    );
    const offerId = offerRows[0].id;

    await client.query(
      `INSERT INTO offer_line_items
         (offer_id, match_id, product_id, quantity, unit_price, discount_pct,
          tag_no, range_text, order_code, config_json, specs_json, line_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
      [
        offerId,
        null,                       // set once the configurator carries the chosen match through
        product.id,
        quantity,
        unitPrice,
        Number(discountPct) || 0,
        tagNo,
        rangeCode,
        fields?.orderCode || null,
        JSON.stringify(config || {}),
        JSON.stringify(extraSpecs || []),
      ]
    );

    await client.query(
      `INSERT INTO audit_log (entity_type, entity_id, actor, action, diff_json)
       VALUES ('offer', $1, NULL, 'create', $2)`,
      [String(offerId), JSON.stringify({ offerNo, productId: product.id, quantity, unitPrice, enquiryId, lineItemId })]
    );

    await client.query('COMMIT');
    return { offerId, offerNo };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// GET /offers — issued offers, newest first.
async function list(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await db.query(
    `SELECT o.id, o.offer_no, o.enquiry_id, o.currency, o.is_export, o.status, o.created_at,
            o.customer_json,
            COUNT(li.id)::int AS line_count,
            SUM(li.quantity * COALESCE(li.unit_price,0) * (1 - COALESCE(li.discount_pct,0)/100)) AS total
       FROM offers o
       LEFT JOIN offer_line_items li ON li.offer_id = o.id
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT $1`,
    [limit]
  );
  res.json(rows);
}

module.exports = { getFields, generate, list };
