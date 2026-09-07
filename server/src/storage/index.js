// server/src/storage/index.js
//
// Single entry point for storage. Everything else in the app does
// `require('../storage')` and never cares whether the driver is local disk
// or S3 — that decision lives in exactly one place: this file, driven by
// STORAGE_DRIVER in .env.

const driver = process.env.STORAGE_DRIVER || 'local';

let impl;
if (driver === 'local') {
  impl = require('./localStorage');
} else {
  throw new Error(`Unknown STORAGE_DRIVER "${driver}". Add server/src/storage/${driver}Storage.js and wire it in here.`);
}

module.exports = impl;