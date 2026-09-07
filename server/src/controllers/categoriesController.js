// server/src/controllers/categoriesController.js
const db = require('../config/db');

// GET /categories
async function listCategories(req, res) {
  const { rows } = await db.query(`SELECT * FROM categories ORDER BY label`);
  res.json(rows);
}

// POST /categories   { id, label, unit }
// Used when a catalogue upload doesn't fit any of the 9 existing families
// (e.g. "pressure_gauge", "diaphragm_seal", "temperature_gauge" — several of
// your new catalogues are exactly this case). Creating the category here
// is what lets the Catalogue Manager UI offer it as a dropdown option
// immediately, no code change.
async function createCategory(req, res) {
  const { id, label, unit } = req.body;
  if (!id || !label) return res.status(400).json({ error: 'id and label are required' });
  const { rows } = await db.query(
    `INSERT INTO categories (id, label, unit) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label, unit=EXCLUDED.unit RETURNING *`,
    [id, label, unit || '']
  );
  res.status(201).json(rows[0]);
}

module.exports = { listCategories, createCategory };