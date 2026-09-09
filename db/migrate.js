// db/migrate.js
// Run with: node db/migrate.js   (or: npm run db:migrate)
//
// Creates the full schema (db/schema.sql) against DATABASE_URL. Deliberately
// plain Node + pg, NOT a shell `psql "$DATABASE_URL" -f db/schema.sql` call —
// that syntax only expands $VAR on a POSIX shell (bash/zsh on macOS/Linux).
// On Windows, npm runs package.json scripts through cmd.exe by default,
// which has no idea what $DATABASE_URL means — it gets passed to psql as
// the 15-character literal string "$DATABASE_URL", the connection fails,
// and schema.sql never actually runs. Depending on your terminal you may
// not even see a loud error for it, which is exactly how a database can end
// up with zero tables ("relation ... does not exist" on everything) while
// db:migrate silently "succeeded." This script reads DATABASE_URL from .env
// itself (same as every other db/*.js script here), so it behaves
// identically on Windows, macOS, and Linux, and doesn't need psql installed
// or on PATH at all.
//
// Meant for a FRESH/EMPTY database — schema.sql is plain CREATE TABLE (no
// IF NOT EXISTS), so running this against a database that already has these
// tables will error on purpose rather than silently no-op. If you're
// upgrading an EXISTING database that was already set up from an older
// version of schema.sql, use `npm run db:migrate-file -- db/migrations/<file>.sql`
// for the specific migration(s) you need instead (each one there is
// idempotent / IF NOT EXISTS, safe to re-run).

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set. Copy .env.example to .env in the repo root ' +
      'and fill in your Postgres connection string first.'
    );
    process.exit(1);
  }

  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
    console.log('Schema created successfully from db/schema.sql.');
    console.log('Next: npm run db:seed (demo data) or npm run db:import-catalogue (your real catalogue export).');
  } catch (err) {
    if (/already exists/i.test(err.message)) {
      console.error(
        `\n${err.message}\n\n` +
        `This looks like some of these tables already exist — db/migrate.js (schema.sql) is meant for a\n` +
        `fresh/empty database, not for upgrading one that's already set up. If you're upgrading an existing\n` +
        `database to pick up a newer feature, run the specific file you need instead, e.g.:\n` +
        `  npm run db:migrate-file -- db/migrations/003_add_datasheet_chunks.sql\n` +
        `(see db/migrations/ for what each one does).`
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
