// server/src/storage/dbStorage.js
//
// Stores catalogue/datasheet files in Postgres instead of on one machine's
// disk. Selected with STORAGE_DRIVER=db in .env.
//
// Same exported shape as localStorage.js, with one difference that matters:
// these functions are ASYNC. A disk read is synchronous; a database read is
// not. Every caller awaits the storage interface now, which costs nothing for
// the local driver (await on a plain value passes straight through) and is
// required for this one.
//
// The point of moving the bytes here is that a catalogue stops being per-
// machine state. With every machine pointed at the same database, an admin
// publishes a datasheet once and every sales engineer can open it — no git
// commit of binaries, no export/import step, no "it works on my machine".
//
// Keys are content hashes (sha256 + extension), identical to what
// localStorage.js produces, so the two drivers are interchangeable and existing
// stored_file_url / file_url values keep resolving after the switch.

const crypto = require('crypto');
const path = require('path');
const db = require('../config/db');

function keyFor(buffer, originalFilename) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = path.extname(originalFilename || '') || '.pdf';
  return { hash, key: `${hash}${ext}` };
}

/**
 * @param {Buffer} buffer
 * @param {string} originalFilename
 * @param {string} [mimeType]
 * @returns {Promise<{url: string, hash: string}>} url is the storage key
 */
async function save(buffer, originalFilename, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('dbStorage.save called with an empty buffer');
  }
  const { hash, key } = keyFor(buffer, originalFilename);

  // Content-addressed, so re-uploading the same PDF is a no-op rather than a
  // duplicate row. The filename is refreshed because the same bytes may arrive
  // under a better name later.
  await db.query(
    `INSERT INTO catalogue_blobs (storage_key, sha256, bytes, byte_size, mime_type, original_filename)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (storage_key) DO UPDATE
       SET original_filename = COALESCE(EXCLUDED.original_filename, catalogue_blobs.original_filename)`,
    [key, hash, buffer, buffer.length, mimeType || 'application/pdf', originalFilename || null]
  );

  return { url: key, hash };
}

/** @returns {Promise<Buffer>} */
async function getBuffer(storageKey) {
  const { rows } = await db.query('SELECT bytes FROM catalogue_blobs WHERE storage_key = $1', [storageKey]);
  if (!rows.length) throw new Error(`No stored file for key "${storageKey}"`);
  return rows[0].bytes;
}

/** @returns {Promise<boolean>} */
async function exists(storageKey) {
  if (!storageKey) return false;
  const { rows } = await db.query('SELECT 1 FROM catalogue_blobs WHERE storage_key = $1', [storageKey]);
  return rows.length > 0;
}

/** Metadata without pulling the bytes — useful for listings and size checks. */
async function stat(storageKey) {
  const { rows } = await db.query(
    'SELECT storage_key, sha256, byte_size, mime_type, original_filename, uploaded_at FROM catalogue_blobs WHERE storage_key = $1',
    [storageKey]
  );
  return rows[0] || null;
}

/**
 * There is no filesystem path for a row in a table. Nothing in the codebase
 * calls this — it exists so the mistake is a clear error rather than an
 * undefined path handed to fs.
 */
function getAbsolutePath() {
  throw new Error(
    'getAbsolutePath() is not available with STORAGE_DRIVER=db — files live in Postgres, not on disk. Use getBuffer().'
  );
}

module.exports = { save, getBuffer, exists, stat, getAbsolutePath };
