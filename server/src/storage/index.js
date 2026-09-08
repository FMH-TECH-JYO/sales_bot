// server/src/storage/index.js
//
// Single entry point for storage. Everything else in the app does
// `require('../storage')` and never cares whether the driver is local disk
// or S3 — that decision lives in exactly one place: this file, driven by
// STORAGE_DRIVER in .env.

// Default is "db": file bytes live in Postgres (see dbStorage.js) so they
// travel with the database instead of being stranded on whichever machine's
// local disk originally received the upload — that was the bug with "local"
// as the default (server/uploads/ is gitignored; a fresh git pull, even
// against the same shared database, had no way to see files another
// developer/deployment had uploaded). "local" is kept for anyone who
// deliberately wants disk-backed storage in a single-machine setup.
const driver = process.env.STORAGE_DRIVER || 'db';

let impl;
if (driver === 'local') {
  impl = require('./localStorage');
} else if (driver === 'db') {
  impl = require('./dbStorage');
} else {
  throw new Error(`Unknown STORAGE_DRIVER "${driver}". Add server/src/storage/${driver}Storage.js and wire it in here.`);
}

module.exports = impl;