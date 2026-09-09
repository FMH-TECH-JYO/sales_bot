// db/seed.js
// Run with: npm run db:seed
//
// Loads categories + the 29-product baseline catalogue into Postgres, AND
// registers each of those products in `catalogue_uploads` (status='published')
// so the Catalogue Manager admin screen shows the full catalogue, not just
// items uploaded through the "upload a PDF" flow.
//
// Idempotent: safe to re-run. Parent rows use ON CONFLICT DO UPDATE; child
// rows (deviations, order codes, code segments, range tables) have no unique
// key to conflict on, so they are deleted and rewritten per product — the old
// version plain-INSERTed them, which silently multiplied every deviation and
// order-code row each time anyone re-ran the seed.
//
// NOTE: this file previously sat in git with three unresolved merge conflict
// blocks (`<<<<<<< HEAD`), which made it a Node SyntaxError — `npm run db:seed`
// crashed before touching Postgres, so a freshly cloned repo could never get
// its baseline catalogue. Resolved in favour of the catalogue_uploads-aware
// version; env loading now goes through config/env.js.

const { assertDatabaseUrl } = require('../config/env');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const connectionString = assertDatabaseUrl();
  const client = new Client({ connectionString });
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
  let uploadsCreated = 0;
  let uploadsSkipped = 0;

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

    // These four have no natural unique key, so re-running the seed would
    // otherwise append a second (third, fourth...) copy of every row.
    await client.query('DELETE FROM product_deviations WHERE product_id = $1', [id]);
    await client.query('DELETE FROM product_order_code_segments WHERE product_id = $1', [id]);
    await client.query('DELETE FROM product_order_codes WHERE product_id = $1', [id]);
    await client.query('DELETE FROM product_range_tables WHERE product_id = $1', [id]);

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

    // --- register this product with the Catalogue Manager ---
    // Without this, the baseline catalogue only exists in `products` and never
    // shows up on the "Catalogue uploads" screen (that screen only reads
    // `catalogue_uploads`, which is otherwise populated solely by the
    // upload-a-PDF admin flow). One row per product here keeps the two in
    // sync for every environment that runs this seed script.
    const { rows: existingUpload } = await client.query(
      `SELECT id FROM catalogue_uploads WHERE product_id = $1 LIMIT 1`,
      [id]
    );
    if (existingUpload.length === 0) {
      const extracted_json = {
        id,
        model: p.model,
        family: p.family,
        blurb: p.blurb,
        val_min: p.valMin,
        val_max: p.valMax,
        temp_max: p.tempMax,
        accuracy: p.accuracy,
        output_type: p.output,
        hazardous: p.hazardous,
        connection: p.connection,
        industries: p.industries || [],
      };
      await client.query(
        `INSERT INTO catalogue_uploads
           (original_filename, stored_file_url, file_hash, mime_type, category_id,
            status, extracted_json, extraction_provider, product_id, published_at)
         VALUES ($1,$2,$3,$4,$5,'published',$6,'seed-baseline',$7,CURRENT_TIMESTAMP)`,
        [`${id}.pdf`, `seed:${id}`, null, null, p.category, extracted_json, id]
      );
      uploadsCreated++;
    } else {
      uploadsSkipped++;
    }
  }

  console.log(`Seed complete. Catalogue Manager: ${uploadsCreated} upload row(s) created, ${uploadsSkipped} already existed.`);
  await client.end();
}

if (require.main === module) {
  main().catch((err) => {
    if (err.code !== 'ENV_MISSING_DATABASE_URL') console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
