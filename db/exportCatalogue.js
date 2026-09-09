// db/exportCatalogue.js
// Run with: npm run db:export-catalogue
//
// Dumps the catalogue tables to db/catalogue_export.json, the file that
// carries catalogue data between machines through git.
//
// ---------------------------------------------------------------------------
// THE BUG THIS FILE USED TO CAUSE (read before changing anything here)
// ---------------------------------------------------------------------------
// catalogueUploadsController.js calls runExport() after EVERY upload, publish
// and reject, best-effort, errors swallowed. The old runExport unconditionally
// overwrote catalogue_export.json with whatever the current database held.
//
// So: any machine whose database was empty — a fresh clone, or one that had
// just been truncated by db:import-catalogue — wrote 13 empty arrays over a
// perfectly good export the moment anyone touched the admin screen. That empty
// file got committed and pushed. The machine that still HAD the data then
// pulled it and ran db:import-catalogue (as DEPLOY.md instructs), which
// truncates first — and the real catalogue was gone everywhere. One round trip
// destroyed the data, and nothing in the loop ever complained.
//
// Two guards now make that impossible:
//   1. HERE: an export that would replace a non-empty file with an empty one
//      is REFUSED. Empty is never a valid thing to publish over real data.
//   2. In importCatalogue.js: an empty export can never truncate a database.
// Both can be overridden deliberately (opts.force / --force) — never by accident.
//
// Writes are atomic (tmp file + rename), so an interrupted export can no
// longer leave a truncated/corrupt JSON file behind either.
//
// Deliberately excludes enquiries/matches/offers/users/customers — those are
// transactional per-deployment data, not catalogue master data.

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, 'catalogue_export.json');

// Insert order matters for foreign keys on import (parents before children).
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

function countRows(dump) {
  return TABLES.reduce((sum, t) => sum + ((dump && dump[t]) ? dump[t].length : 0), 0);
}

/** Row count currently on disk in catalogue_export.json (0 if absent/unreadable). */
function existingRowCount() {
  if (!fs.existsSync(OUT_PATH)) return 0;
  try {
    return countRows(JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')));
  } catch {
    return 0;
  }
}

function writeAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

/**
 * Dump every catalogue table to db/catalogue_export.json.
 * @param {{query: (sql: string) => Promise<{rows: any[]}>}} queryable app db module or a pg Client
 * @param {{silent?: boolean, force?: boolean}} [opts]
 * @returns {Promise<{dump: Record<string, any[]>, totalRows: number, written: boolean, reason?: string}>}
 */
async function runExport(queryable, opts = {}) {
  const log = opts.silent ? () => {} : (...args) => console.log(...args);

  const dump = {};
  for (const table of TABLES) {
    const { rows } = await queryable.query(`SELECT * FROM ${table}`);
    dump[table] = rows;
    log(`  ${table}: ${rows.length} rows`);
  }
  const totalRows = countRows(dump);
  const onDisk = existingRowCount();

  if (totalRows === 0 && onDisk > 0 && !opts.force) {
    // The guard. Never silent — this is the exact moment data used to be lost.
    console.warn(
      `\n[export] REFUSED to overwrite db/catalogue_export.json.\n` +
      `         This database has 0 catalogue rows, but the existing export has ${onDisk}.\n` +
      `         Writing would replace a real catalogue with an empty one, and committing\n` +
      `         that would wipe every machine that imports it.\n` +
      `         The export file was left untouched.\n` +
      `         If your database really should be empty and you mean to publish that,\n` +
      `         run: npm run db:export-catalogue -- --force\n`
    );
    return { dump, totalRows, written: false, reason: 'refused-empty-over-nonempty' };
  }

  dump._meta = {
    exported_at: new Date().toISOString(),
    total_rows: totalRows,
    row_counts: Object.fromEntries(TABLES.map((t) => [t, dump[t].length])),
  };

  writeAtomic(OUT_PATH, JSON.stringify(dump, null, 2));
  log(`\nWrote ${OUT_PATH} (${totalRows} rows)`);
  return { dump, totalRows, written: true };
}

async function main() {
  const { assertDatabaseUrl } = require('../config/env');
  const connectionString = assertDatabaseUrl();
  const { Client } = require('pg');
  const force = process.argv.includes('--force');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await runExport(client, { force });
    if (result.written) {
      console.log('Commit this file AND any new files under server/uploads/, then push.');
    } else {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err.code !== 'ENV_MISSING_DATABASE_URL') console.error(err);
    process.exit(1);
  });
}

module.exports = { runExport, countRows, existingRowCount, TABLES, OUT_PATH };
