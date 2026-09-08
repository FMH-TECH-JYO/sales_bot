// Cross-platform schema migration runner.  Avoids requiring the PostgreSQL
// `psql` command-line utility on a developer machine; Docker + Node are all
// this project needs.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT to_regclass('public.categories') AS categories_table");
    if (rows[0].categories_table) {
      console.log('Database schema is already ready.');
      return;
    }
    await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    console.log('Database schema is ready.');
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
