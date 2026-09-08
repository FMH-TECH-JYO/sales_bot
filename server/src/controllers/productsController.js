// server/src/controllers/productsController.js
const db = require('../config/db');

// GET /products?category=pressure_switch
async function listProducts(req, res) {
  const { category } = req.query;
  const params = [];
  let sql = `
    SELECT p.*, c.label AS category_label,
      EXISTS(
        SELECT 1 FROM product_catalogue_files f
        WHERE f.product_id = p.id AND f.is_current = TRUE
      ) AS has_catalogue
    FROM products p JOIN categories c ON c.id = p.category_id`;
  if (category) {
    params.push(category);
    sql += ` WHERE p.category_id = $1`;
  }
  sql += ` ORDER BY p.family, p.id`;
  const { rows } = await db.query(sql, params);
  res.json(rows);
}

// GET /products/:id — full detail with every joined child table, same shape as products_seed.json's per-product object
async function getProduct(req, res) {
  const { id } = req.params;
  const { rows: productRows } = await db.query(`SELECT * FROM products WHERE id = $1`, [id]);
  if (!productRows.length) return res.status(404).json({ error: 'Not found' });
  const product = productRows[0];

  const [industries, keywords, extraSpec, deviations, orderCode, segments, rangeTable, catalogueFile] = await Promise.all([
    db.query(`SELECT industry FROM product_industries WHERE product_id=$1`, [id]),
    db.query(`SELECT keyword FROM product_keywords WHERE product_id=$1`, [id]),
    db.query(`SELECT label, value FROM product_extra_spec WHERE product_id=$1`, [id]),
    db.query(`SELECT text, type FROM product_deviations WHERE product_id=$1`, [id]),
    db.query(`SELECT skeleton, example FROM product_order_codes WHERE product_id=$1`, [id]),
    db.query(`SELECT segment_no, parameter, option_code, option_label FROM product_order_code_segments WHERE product_id=$1 ORDER BY segment_no`, [id]),
    db.query(`SELECT title, note, code, unit, range_text FROM product_range_tables WHERE product_id=$1`, [id]),
    db.query(`SELECT file_url, version FROM product_catalogue_files WHERE product_id=$1 AND is_current=TRUE`, [id]),
  ]);

  res.json({
    ...product,
    industries: industries.rows.map(r => r.industry),
    keywords: keywords.rows.map(r => r.keyword),
    extraSpec: Object.fromEntries(extraSpec.rows.map(r => [r.label, r.value])),
    deviations: deviations.rows,
    orderCode: orderCode.rows[0] || null,
    codeSegments: segments.rows,
    rangeTable: rangeTable.rows,
    catalogueFile: catalogueFile.rows[0] || null,
  });
}

// GET /products/:id/catalogue — streams the current datasheet so it opens
// in the browser's own PDF viewer (view first). The viewer's own toolbar
// then provides the download button — no need to force a download here,
// which would just silently save the file with no way to look at it first.
async function downloadCatalogue(req, res) {
  const storage = require('../storage');
  const { rows } = await db.query(
    `SELECT file_url, product_id FROM product_catalogue_files WHERE product_id=$1 AND is_current=TRUE`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No catalogue file on record for this product' });
  // The DB row exists but the actual PDF bytes might not — e.g. this
  // machine's database was restored via db:import-catalogue but
  // server/uploads/ wasn't pulled/committed alongside it (or a file was
  // deleted from disk directly). Give a clear, actionable error instead of
  // a raw ENOENT/500 — this is the #1 way "download isn't working" reports
  // happen, and the fix is always the same: see DEPLOY.md.
  if (!storage.exists(rows[0].file_url)) {
    return res.status(404).json({
      error: `Datasheet PDF for "${rows[0].product_id}" is missing from this server's storage (expected key ${rows[0].file_url}). ` +
        `The catalogue database record exists, but the actual file isn't on disk. This usually means server/uploads/ wasn't pulled ` +
        `or committed alongside the database export on this machine — see DEPLOY.md's "moving this app to another machine" section.`,
    });
  }
  const buffer = storage.getBuffer(rows[0].file_url);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].product_id}.pdf"`);
  res.send(buffer);
}

module.exports = { listProducts, getProduct, downloadCatalogue };