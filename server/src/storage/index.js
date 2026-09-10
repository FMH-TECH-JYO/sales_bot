// server/src/storage/index.js
//
// Single entry point for storage. Everything else does `require('../storage')`
// and never cares whether the driver is local disk, the database, or S3 —
// that decision lives in exactly one place: this file, driven by
// STORAGE_DRIVER in .env.
//
// config/env.js is required FIRST and on purpose. This module reads
// process.env at import time, and it used to rely on some other module
// (server/src/config/db.js) having loaded dotenv earlier in the require
// graph. That worked only because index.js happens to require ./config/db
// before the routes — any script that pulled in storage on its own got
// STORAGE_DRIVER === undefined. Loading env here makes this module correct
// regardless of import order. config/env.js is idempotent.

require('../../../config/env');

const driver = process.env.STORAGE_DRIVER || 'local';

// NOTE: the storage interface is now treated as ASYNC by every caller. The
// local driver stays synchronous and `await` passes its values straight
// through; the db driver returns real promises. Any future driver (s3Storage)
// only has to export save/getBuffer/exists with the same shape.
let impl;
if (driver === 'local') {
  impl = require('./localStorage');
} else if (driver === 'db') {
  impl = require('./dbStorage');
} else {
  throw new Error(`Unknown STORAGE_DRIVER "${driver}". Valid values: "local", "db". To add another, write server/src/storage/${driver}Storage.js exporting save/getBuffer/exists and wire it in here.`);
}

module.exports = impl;
