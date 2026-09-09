// db/setup.js
// Run with: npm run setup
//
// The one command a freshly cloned repo needs. Idempotent — run it as often
// as you like, including right after every `git pull`.
//
//   1. Makes sure .env exists (config/env.js creates it from .env.example).
//   2. Checks Postgres is actually reachable, and says what to do if not.
//   3. Runs pending schema migrations (db/migrate.js — safe on fresh AND
//      existing databases).
//   4. Loads catalogue data, choosing the safe option automatically:
//        - db/catalogue_export.json has rows  -> import it
//        - export empty, database empty       -> seed the 29-product baseline
//        - export empty, database has data    -> leave the database alone
//      That last case is the important one: an empty export never destroys a
//      populated database (see importCatalogue.js).
//
// Replaces the old three-step "npm run db:migrate && npm run db:import-catalogue"
// from DEPLOY.md, where getting the order or the situation wrong quietly lost
// the catalogue.

const { assertDatabaseUrl, ENV_PATH } = require('../config/env');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { countRows, OUT_PATH } = require('./exportCatalogue');

async function checkConnection(connectionString) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.end();
  } catch (err) {
    console.error(
      '\n================================================================\n' +
      ' Cannot reach Postgres.\n' +
      '================================================================\n' +
      `  ${err.message}\n\n` +
      `  DATABASE_URL is read from: ${ENV_PATH}\n\n` +
      '  Most likely the database is not running. Start it with:\n' +
      '    docker compose up -d\n\n' +
      '  Then re-run:  npm run setup\n'
    );
    process.exit(1);
  }
}

async function productCount(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM products');
    return rows[0].n;
  } finally {
    await client.end();
  }
}

async function main() {
  const connectionString = assertDatabaseUrl();

  console.log('1/3  Checking database connection...');
  await checkConnection(connectionString);
  console.log('     OK.');

  console.log('\n2/3  Applying schema / migrations...');
  await require('./migrate').main();

  console.log('\n3/3  Loading catalogue data...');
  const exportRows = fs.existsSync(OUT_PATH)
    ? countRows(JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')))
    : 0;
  const dbProducts = await productCount(connectionString);

  if (exportRows > 0) {
    console.log(`     db/catalogue_export.json has ${exportRows} rows — importing.`);
    await require('./importCatalogue').main();
  } else if (dbProducts === 0) {
    console.log('     Export is empty and this database has no products — seeding the baseline catalogue.');
    await require('./seed').main();
  } else {
    console.log(
      `     Export is empty but this database already has ${dbProducts} products.\n` +
      '     Leaving it alone — an empty export must never overwrite real data.\n' +
      '     If this machine is the source of truth, publish it with:\n' +
      '       npm run catalogue:sync && git push'
    );
  }

  console.log('\nSetup complete. Start the app with:  npm run dev:server');
}

main().catch((err) => {
  if (err.code !== 'ENV_MISSING_DATABASE_URL') console.error(err.message || err);
  process.exit(1);
});
