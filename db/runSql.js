// db/runSql.js
// Run with: node db/runSql.js <path-to-sql-file>   (or: npm run db:migrate-file -- <path>)
//
// Cross-platform way to execute any one .sql file against DATABASE_URL —
// use this instead of `psql "$DATABASE_URL" -f <file>`, whose $VAR syntax
// only expands on a POSIX shell and silently fails on Windows (see the
// comment at the top of db/migrate.js for the full story). Mainly meant for
// applying files under db/migrations/ one at a time when upgrading an
// existing database that already has data in it.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node db/runSql.js <path-to-sql-file>');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env in the repo root and fill in your Postgres connection string first.');
    process.exit(1);
  }

  const sql = fs.readFileSync(file, 'utf8');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`Ran ${file} successfully.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
