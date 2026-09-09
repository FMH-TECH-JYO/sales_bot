// db/importCatalogue.js
// Run with: npm run db:import-catalogue
//
// Loads db/catalogue_export.json (produced on the machine you publish from,
// committed to git, pulled here) and REPLACES this database's catalogue with
// it. Run after `git pull`, once `npm run db:migrate` has created the schema.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE IS PARANOID NOW
// ---------------------------------------------------------------------------
// The old version ran
//     TRUNCATE <13 tables> RESTART IDENTITY CASCADE
// BEFORE looking at how many rows the export actually contained. The export
// file in git was all-empty arrays (see the note at the top of
// exportCatalogue.js for how it got that way), so this command's whole job
// became: silently delete the entire catalogue and replace it with nothing.
// It reported success. That is how the catalogue kept "going empty on every
// pull" — the pull was fine, this script was the thing destroying the data.
//
// Three changes make that non-repeatable:
//   1. An export with zero rows is REFUSED outright. Nothing is truncated.
//   2. Before truncating anything, the CURRENT database catalogue is dumped
//      to db/.backups/catalogue_before_import_<timestamp>.json. If an import
//      ever does turn out to be wrong, the previous state is recoverable
//      instead of gone.
//   3. Row counts before and after are printed, so a destructive import is
//      visible in the terminal rather than reported as plain "complete".
//
// Still a full REPLACE, not a merge: catalogue data has one source of truth,
// the machine you publish from. TRUNCATE ... CASCADE also empties `matches`
// and `offer_line_items` (they reference products) — that is the blast radius.

const { assertDatabaseUrl } = require('../config/env');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { TABLES, countRows } = require('./exportCatalogue');

const IN_PATH = path.join(__dirname, 'catalogue_export.json');
const BACKUP_DIR = path.join(__dirname, '.backups');

async function backupCurrent(client) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dump = {};
  for (const table of TABLES) {
    const { rows } = await client.query(`SELECT * FROM ${table}`);
    dump[table] = rows;
  }
  const total = countRows(dump);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `catalogue_before_import_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  return { file, total };
}

async function main() {
  const force = process.argv.includes('--force');
  const connectionString = assertDatabaseUrl();

  if (!fs.existsSync(IN_PATH)) {
    console.error(
      `No ${IN_PATH} found.\n` +
      `Run "npm run db:export-catalogue" on the machine that has the catalogue, commit it, push, and pull here.`
    );
    process.exit(1);
  }

  const dump = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));
  const incoming = countRows(dump);

  if (incoming === 0 && !force) {
    console.error(
      '\n================================================================\n' +
      ' REFUSED: db/catalogue_export.json contains 0 rows.\n' +
      '================================================================\n' +
      '  Importing it would TRUNCATE this database\'s catalogue and put\n' +
      '  nothing back. Your database has NOT been touched.\n\n' +
      '  This means the export in git is empty — the machine that pushed it\n' +
      '  exported from an empty database. Fix it at the source:\n\n' +
      '    On the machine that HAS the catalogue:\n' +
      '      npm run db:export-catalogue      (must report a non-zero row count)\n' +
      '      npm run catalogue:sync           (stages + commits export and PDFs)\n' +
      '      git push\n\n' +
      '    Then here:\n' +
      '      git pull && npm run db:import-catalogue\n\n' +
      '  If NO machine has the catalogue any more, start from the baseline:\n' +
      '      npm run db:seed\n\n' +
      '  To import an empty catalogue on purpose anyway:\n' +
      '      npm run db:import-catalogue -- --force\n'
    );
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const before = await backupCurrent(client);
    console.log(`Current catalogue: ${before.total} rows. Backup written to ${before.file}`);
    console.log(`Incoming export:   ${incoming} rows.`);

    if (before.total > 0 && incoming < before.total) {
      console.warn(
        `\nWarning: the import will REDUCE this database from ${before.total} to ${incoming} rows.\n` +
        `Continuing (the backup above is your undo).\n`
      );
    }

    await client.query('BEGIN');
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
      // Serial PKs got explicit ids from the dump; resync the sequence so the
      // next auto-generated id doesn't collide. Guarded on
      // pg_get_serial_sequence returning something, since categories/products
      // use a hand-assigned TEXT "id" and have no sequence.
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
    console.log(`\nCatalogue import complete: ${before.total} rows -> ${incoming} rows.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
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

module.exports = { main };
