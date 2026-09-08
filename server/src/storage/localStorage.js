// server/src/storage/localStorage.js
//
// Storage interface used by the whole app. Every other file talks to
// storage through save()/getBuffer()/exists() — never touches fs directly.
// This is the ONLY file that changes when you move from local disk to S3:
// write server/src/storage/s3Storage.js with the same exports, then flip
// STORAGE_DRIVER in .env. Nothing else in the codebase changes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = path.resolve(__dirname, '../../', process.env.LOCAL_UPLOAD_DIR || 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * @param {Buffer} buffer - file contents
 * @param {string} originalFilename
 * @param {string} [mimeType] - accepted for interface parity with dbStorage.js; unused here (not persisted to disk)
 * @returns {{ url: string, hash: string }} url is a storage-relative key (not a public URL yet)
 */
function save(buffer, originalFilename, mimeType) { // eslint-disable-line no-unused-vars
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = path.extname(originalFilename) || '.pdf';
  const key = `${hash}${ext}`;
  const fullPath = path.join(UPLOAD_DIR, key);
  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, buffer);
  }
  return { url: key, hash };
}

/** Resolve a storage key (as saved in the DB) back to a readable path/buffer. */
function getBuffer(storageKey) {
  return fs.readFileSync(path.join(UPLOAD_DIR, storageKey));
}

function getAbsolutePath(storageKey) {
  return path.join(UPLOAD_DIR, storageKey);
}

function exists(storageKey) {
  return fs.existsSync(path.join(UPLOAD_DIR, storageKey));
}

module.exports = { save, getBuffer, getAbsolutePath, exists };