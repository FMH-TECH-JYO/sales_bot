// server/src/config/db.js
// One pool, imported everywhere that needs the database.
// This is the ONLY file that should import 'pg' directly — everything else
// goes through this module, so swapping database driver/host later touches
// one file, not every route.

const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres error on idle client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};