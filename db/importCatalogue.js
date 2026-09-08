// db/importCatalogue.js
// Run with: node db/importCatalogue.js   (or: npm run db:import-catalogue)
//
// Loads db/catalogue_export.json (produced by exportCatalogue.js on the
// source machine, committed to git, pulled here) and REPLACES the current
// database's catalogue tables with it — categories, products and every
// child table, plus the admin upload/review history. Run this after
// `git pull` brings in a new catalogue_export.json, and after making sure
// `npm run db:migrate` has been run at least once so the schema exists.
//
// This is a full REPLACE, not a merge: it truncates the catalogue tables
// first so the result exactly matches the export (catalogue data should
// have one source of truth — the machine you actually publish from —
// not be hand-merged across machines). Because Postgres foreign keys
// cascade on TRUNCATE, this also empties `matches` and `offer_line_items`
// (both reference products) if you've since started using those tables —
// they aren't part of the catalogue export and currently aren't written
// to anywhere in the app, but that's the actual blast radius, so don't run
// this against a database you're relying on for enquiry-tracking history.

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const IN_PATH = path.join(__dirname, 'catalogue_export.json');

// Insert order matters for the FKs (parents before children).
const TABLES = [
  'categories',
  'products',
  'product_industries',
  'product_keywords',
  'product_extra_spec',
  'product_deviations',
  'product_order_codes',
  'product_order_code_segments',
  'product_range_tables',
  'product_catalogue_files',
  'catalogue_uploads',
];

async function main() {
  if (!fs.existsSync(IN_PATH)) {
    console.error(`No ${IN_PATH} found. Run exportCatalogue.js on the source machine, commit it, and pull it here first.`);
    process.exit(1);
  }
  const dump = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Single TRUNCATE ... CASCADE covers every catalogue table (and
    // anything else that references them) in the right order automatically
    // — see the file-level comment for exactly what that includes.
    await client.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);

    for (const table of TABLES) {
      const rows = dump[table] || [];
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      const colList = columns.map((c) => `"${c}"`).join(', ');
      for (const row of rows) {
        const values = columns.map((c) => row[c]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})`, values);
      }
      // Serial PKs (product_deviations, catalogue_uploads, etc. — NOT
      // categories/products, whose "id" is a hand-assigned TEXT code) got
      // explicit ids from the dump; resync the sequence so the next
      // auto-generated id doesn't collide with an imported one. Guarded on
      // pg_get_serial_sequence actually returning something, since calling
      // setval(NULL, ...) errors for a non-serial "id" column.
      if (columns.includes('id')) {
        const { rows: seqRows } = await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [table]);
        const seqName = seqRows[0]?.seq;
        if (seqName) {
          await client.query(`SELECT setval($1, COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`, [seqName]);
        }
      }
      console.log(`  ${table}: ${rows.length} rows imported`);
    }

    await client.query('COMMIT');
    console.log('\nCatalogue import complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
