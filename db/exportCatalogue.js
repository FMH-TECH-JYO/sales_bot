// db/exportCatalogue.js
// Run with: node db/exportCatalogue.js   (or: npm run db:export-catalogue)
//
// git never carries your Postgres data — pushing code and pulling it on
// another machine gets you the SCHEMA (via schema.sql) but an empty
// database. This dumps everything that makes up your actual catalogue
// (categories, published products and every child table, plus the admin
// upload/review history) to db/catalogue_export.json, a plain JSON file
// meant to be committed to git alongside the real datasheet PDFs in
// server/uploads/ (see .gitignore's note on that). Run this after
// publishing/updating catalogue entries and before you `git push`; run
// importCatalogue.js after `git pull` on the other machine. See DEPLOY.md.
//
// Deliberately excludes enquiries/matches/offers/users/customers — those
// are transactional, per-deployment data, not catalogue master data, and
// exporting them would silently overwrite whatever's happening on the
// target machine.

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, 'catalogue_export.json');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const tables = [
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

  const dump = {};
  for (const table of tables) {
    const { rows } = await client.query(`SELECT * FROM ${table}`);
    dump[table] = rows;
    console.log(`  ${table}: ${rows.length} rows`);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(dump, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
  console.log('Commit this file AND any new files under server/uploads/, then push.');

  await client.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
