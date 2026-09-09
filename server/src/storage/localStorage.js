// server/src/storage/localStorage.js
//
// Storage interface used by the whole app. Every other file talks to storage
// through save()/getBuffer()/exists() — never touches fs directly. This is the
// ONLY file that changes when you move from local disk to S3 or to the
// database: write another module with the same exports, then flip
// STORAGE_DRIVER in .env. Nothing else in the codebase changes.
//
// UPLOAD PATH FIX
// ---------------
// This used to be:
//     path.resolve(__dirname, '../../', process.env.LOCAL_UPLOAD_DIR || 'uploads')
// __dirname is <repo>/server/src/storage, so '../../' is <repo>/server, and
// .env.example ships LOCAL_UPLOAD_DIR='./server/uploads'. Joined, that is
//     <repo>/server/server/uploads
// while the datasheet PDFs committed to git live in <repo>/server/uploads.
// A machine WITH a .env therefore wrote uploads into a folder nothing else
// reads (this repo currently has 3 PDFs stranded in server/server/uploads and
// 43 in server/uploads), and a machine WITHOUT a .env silently used the
// fallback 'uploads' and got the right folder. Same code, two different
// storage locations depending on whether a gitignored file happened to exist.
//
// The path now comes from config/env.js's uploadDir(), which resolves it
// against the repo root — so './server/uploads' means <repo>/server/uploads
// on every machine, .env or not.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { uploadDir } = require('../../../config/env');

const UPLOAD_DIR = uploadDir();

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * @param {Buffer} buffer - file contents
 * @param {string} originalFilename
 * @param {string} [mimeType] - accepted for interface parity with other drivers; unused here
 * @returns {{ url: string, hash: string }} url is a storage-relative key (not a public URL)
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

/** Resolve a storage key (as saved in the DB) back to a readable buffer. */
function getBuffer(storageKey) {
  return fs.readFileSync(path.join(UPLOAD_DIR, storageKey));
}

function getAbsolutePath(storageKey) {
  return path.join(UPLOAD_DIR, storageKey);
}

function exists(storageKey) {
  return fs.existsSync(path.join(UPLOAD_DIR, storageKey));
}

module.exports = { save, getBuffer, getAbsolutePath, exists, UPLOAD_DIR };
