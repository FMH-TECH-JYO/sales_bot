// server/src/config/db.js
// One pool, imported everywhere that needs the database. This is the ONLY
// file that imports 'pg' directly — everything else goes through this module.
//
// Environment now comes from config/env.js (the single loader for the whole
// repo). The old version called dotenv here with a hand-counted '../../../.env'
// path; when that file didn't exist — which is ALWAYS true on a fresh clone,
// because .env is gitignored — DATABASE_URL was undefined, the Pool fell back
// to pg's defaults with no password, and the only thing the user ever saw was
//
//     SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
//
// assertDatabaseUrl() now fails first, with a message that says what to do.

const { assertDatabaseUrl } = require('../../../config/env');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: assertDatabaseUrl(),
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
