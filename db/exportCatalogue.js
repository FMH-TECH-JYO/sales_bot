// db/exportCatalogue.js
// Run with: node db/exportCatalogue.js   (or: npm run db:export-catalogue)
//
// git never carries your Postgres data — pushing code and pulling it on
// another machine gets you the SCHEMA (via schema.sql) but an empty
// database. This dumps everything that makes up your actual catalogue
// (categories, published products and every child table — INCLUDING the
// chunked RAG text in product_datasheet_chunks / catalogue_upload_chunks,
// so the matching pipeline's internal retrieval index travels with the
// data, not just the raw PDFs — plus the admin upload/review history) to
// db/catalogue_export.json, a plain JSON file meant to be committed to git
// alongside the real datasheet PDFs in server/uploads/ (see .gitignore's
// note on that). See DEPLOY.md.
//
// Deliberately excludes enquiries/matches/offers/users/customers — those
// are transactional, per-deployment data, not catalogue master data, and
// exporting them would silently overwrite whatever's happening on the
// target machine.
//
// You normally DON'T need to run this by hand: the admin server calls
// runExport() automatically at the end of every successful catalogue
// publish (see publishCatalogue() in catalogueUploadsController.js), so
// db/catalogue_export.json is always up to date on disk. Run this script
// manually only if you need to force a refresh outside of publishing (e.g.
// after directly editing the database).

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, 'catalogue_export.json');

const TABLES = [
  'categories',
  'products',
  'product_industries',
  'product_keywords',
  'product_extra_spec',
  'product_datasheet_chunks',
  'product_deviations',
  'product_order_codes',
  'product_order_code_segments',
  'product_range_tables',
  'product_catalogue_files',
  'catalogue_uploads',
  'catalogue_upload_chunks',
];

/**
 * Dumps every catalogue table to db/catalogue_export.json using whatever
 * queryable client/pool is passed in (works with either the app's shared
 * `db` module or a standalone `pg` Client from the CLI path below).
 * @param {{query: (sql: string) => Promise<{rows: any[]}>}} queryable
 * @param {{silent?: boolean}} [opts]
 * @returns {Promise<Record<string, any[]>>} the dump object that was written
 */
async function runExport(queryable, opts = {}) {
  const log = opts.silent ? () => {} : (...args) => console.log(...args);
  const dump = {};
  for (const table of TABLES) {
    const { rows } = await queryable.query(`SELECT * FROM ${table}`);
    dump[table] = rows;
    log(`  ${table}: ${rows.length} rows`);
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(dump, null, 2));
  log(`\nWrote ${OUT_PATH}`);
  return dump;
}

async function main() {
  require('dotenv').config();
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await runExport(client);
    console.log('Commit this file AND any new files under server/uploads/, then push.');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { runExport, TABLES, OUT_PATH };
