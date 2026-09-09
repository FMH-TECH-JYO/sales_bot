// db/runSql.js
// Run with: npm run db:migrate-file -- db/migrations/00X_whatever.sql
//
// Escape hatch for executing ONE .sql file against DATABASE_URL by hand.
// Cross-platform replacement for `psql "$DATABASE_URL" -f <file>`, whose
// $VAR syntax only expands on a POSIX shell and silently does the wrong
// thing on Windows (see the comment at the top of db/migrate.js).
//
// You normally don't need this: `npm run db:migrate` now tracks what has
// been applied in the schema_migrations table and runs pending migrations
// itself. Use this only for ad-hoc SQL that isn't a numbered migration.
//
// NOTE: this file previously sat in git with unresolved merge conflict
// markers, which made it a Node SyntaxError. Resolved: env loading now goes
// through config/env.js like everything else.

const { assertDatabaseUrl } = require('../config/env');
const { Client } = require('pg');
const fs = require('fs');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: npm run db:migrate-file -- <path-to-sql-file>');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }

  const connectionString = assertDatabaseUrl();
  const sql = fs.readFileSync(file, 'utf8');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`Ran ${file} successfully.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (err.code !== 'ENV_MISSING_DATABASE_URL') console.error(err.message || err);
  process.exit(1);
});
