// db/seed.js
// Run with: node db/seed.js
// Loads categories + the 29-product baseline catalogue into Postgres.
// Idempotent: safe to re-run (uses ON CONFLICT DO UPDATE / DO NOTHING).

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const seedPath = path.join(__dirname, 'products_seed.json');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

  console.log(`Seeding ${seed.categories.length} categories, ${seed.products.length} products...`);

  // --- categories ---
  for (const cat of seed.categories) {
    const unit = seed.units[cat.id] || '';
    await client.query(
      `INSERT INTO categories (id, label, unit) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, unit = EXCLUDED.unit`,
      [cat.id, cat.label, unit]
    );
  }

  // --- products (+ children) ---
  let syntheticIdCounter = 1;
  for (const p of seed.products) {
    // two temp_switch entries in the seed have model:'—' (no catalogue code) — give them a stable synthetic id
    const id = p.model && p.model !== '—'
      ? p.model
      : `NOCODE-${p.category.toUpperCase()}-${syntheticIdCounter++}`;

    await client.query(
      `INSERT INTO products
         (id, model, family, category_id, blurb, val_min, val_max, temp_max, accuracy, output_type, hazardous, connection, no_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         family=EXCLUDED.family, blurb=EXCLUDED.blurb, val_min=EXCLUDED.val_min, val_max=EXCLUDED.val_max,
         temp_max=EXCLUDED.temp_max, accuracy=EXCLUDED.accuracy, output_type=EXCLUDED.output_type,
         hazardous=EXCLUDED.hazardous, connection=EXCLUDED.connection, updated_at=CURRENT_TIMESTAMP`,
      [id, p.model, p.family, p.category, p.blurb, p.valMin, p.valMax, p.tempMax,
       p.accuracy, p.output, p.hazardous, p.connection, !!p.noCode]
    );

    for (const industry of p.industries || []) {
      await client.query(
        `INSERT INTO product_industries (product_id, industry) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, industry]
      );
    }
    for (const keyword of p.keywords || []) {
      await client.query(
        `INSERT INTO product_keywords (product_id, keyword) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, keyword]
      );
    }
    for (const [label, value] of Object.entries(p.extraSpec || {})) {
      await client.query(
        `INSERT INTO product_extra_spec (product_id, label, value) VALUES ($1,$2,$3)
         ON CONFLICT (product_id, label) DO UPDATE SET value = EXCLUDED.value`,
        [id, label, value]
      );
    }
    for (const d of p.deviations || []) {
      await client.query(
        `INSERT INTO product_deviations (product_id, text, type) VALUES ($1,$2,$3)`,
        [id, d, 'caveat']
      );
    }
    if (p.orderCode) {
      await client.query(
        `INSERT INTO product_order_codes (product_id, skeleton, example) VALUES ($1,$2,$3)`,
        [id, p.orderCode.skeleton, p.orderCode.example]
      );
    }
    for (const seg of p.codeTable || []) {
      for (const [code, label] of seg.options) {
        await client.query(
          `INSERT INTO product_order_code_segments (product_id, segment_no, parameter, option_code, option_label)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, String(seg.seg), seg.name, code, label]
        );
      }
    }
    if (p.rangeTable) {
      for (const [code, unit, range] of p.rangeTable.rows) {
        await client.query(
          `INSERT INTO product_range_tables (product_id, title, note, code, unit, range_text)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, p.rangeTable.title, p.rangeTable.note || null, code, unit, range]
        );
      }
    }
  }

  console.log('Seed complete.');
  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });