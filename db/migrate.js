// db/migrate.js
// Run with: npm run db:migrate
//
// Idempotent. Safe to run on a fresh database, on a database that is already
// set up, and twice in a row. This replaces the old version, which was:
//   - checked into git WITH UNRESOLVED MERGE CONFLICT MARKERS (`<<<<<<< HEAD`),
//     making the file a Node SyntaxError, so `npm run db:migrate` crashed on
//     every fresh clone before it ever touched Postgres — which is why a
//     pulled repo ended up with zero tables and an "empty database";
//   - deliberately non-idempotent (schema.sql is plain CREATE TABLE), so on a
//     database that DID exist it errored out and told you to hand-pick files
//     from db/migrations/ yourself.
//
// What it does now:
//   1. Creates the schema_migrations bookkeeping table if absent.
//   2. If the schema has never been installed (no `products` table), runs
//      db/schema.sql once, then records every file in db/migrations/ as
//      already applied — schema.sql is the current shape, it already
//      includes them.
//   3. Otherwise, applies any db/migrations/*.sql not yet recorded, in
//      filename order, each in its own transaction.
//
// Deliberately plain Node + pg rather than `psql "$DATABASE_URL" -f ...`:
// that $VAR syntax only expands on a POSIX shell. On Windows npm runs
// scripts through cmd.exe, which passes the literal string "$DATABASE_URL"
// to psql — the connection fails, the schema is never created, and nothing
// obvious tells you so. This works identically on Windows, macOS and Linux
// and does not need psql installed at all.

const { assertDatabaseUrl } = require('../config/env');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

async function tableExists(client, name) {
  const { rows } = await client.query('SELECT to_regclass($1) AS reg', [`public.${name}`]);
  return rows[0].reg !== null;
}

async function main() {
  const connectionString = assertDatabaseUrl();
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const freshDatabase = !(await tableExists(client, 'products'));

    if (freshDatabase) {
      console.log('No schema found — installing db/schema.sql...');
      await client.query('BEGIN');
      await client.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
      for (const file of migrationFiles()) {
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file]
        );
      }
      await client.query('COMMIT');
      console.log(`Schema installed. ${migrationFiles().length} migration(s) marked as already included.`);
      console.log('Next: npm run db:import-catalogue (real catalogue) or npm run db:seed (29-product demo baseline).');
      return;
    }

    const { rows: applied } = await client.query('SELECT filename FROM schema_migrations');
    const done = new Set(applied.map((r) => r.filename));
    const pending = migrationFiles().filter((f) => !done.has(f));

    if (pending.length === 0) {
      console.log('Database schema is already up to date — nothing to apply.');
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${err.message}`);
      }
    }
    console.log(`Applied ${pending.length} migration(s). Schema is up to date.`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err.code !== 'ENV_MISSING_DATABASE_URL') console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { main };
