-- db/migrations/006_catalogue_blobs.sql
--
-- Datasheet PDFs move INTO the database.
--
-- WHY
-- ---
-- Until now the bytes lived on one machine's disk in server/uploads/, and the
-- only way to get them onto another machine was to commit 20 MB of binaries to
-- git and hope every clone pulled them. That is what produced:
--   * "Not yet uploaded to the catalogue library" for products that plainly had
--     a datasheet in someone's admin console,
--   * the empty-catalogue_export.json loop that truncated the catalogue on
--     every machine that pulled it,
--   * three working copies each with a different idea of what the catalogue is.
--
-- With the bytes in Postgres and every machine pointed at the same Neon
-- instance, "pulling the code" stops having anything to do with the data. An
-- admin publishes a datasheet once and every user sees it immediately —
-- no export, no import, no git, no sync step to forget.
--
-- KEYED BY STORAGE KEY, ON PURPOSE
-- --------------------------------
-- localStorage.js already names every file sha256(bytes) + extension, and that
-- key is what catalogue_uploads.stored_file_url and
-- product_catalogue_files.file_url already contain. Using the same key as the
-- primary key here means NOT ONE referencing row has to change: the rows keep
-- pointing at the same string, and only the storage driver changes where the
-- bytes come from. It also gives content de-duplication for free — the same
-- datasheet uploaded twice is stored once.
--
-- SIZE
-- ----
-- Postgres stores bytea over ~2 KB out-of-line and compressed (TOAST), up to
-- 1 GB per value. Today's catalogue is 44 files / 20 MB, average 465 KB, largest
-- 2.3 MB — comfortably inside that. Watch the Neon plan's storage limit rather
-- than Postgres itself; if the catalogue ever runs to thousands of datasheets,
-- write an s3Storage.js and flip STORAGE_DRIVER. Nothing else changes.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS catalogue_blobs (
  storage_key       TEXT PRIMARY KEY,          -- == stored_file_url / file_url
  sha256            TEXT NOT NULL,
  bytes             BYTEA NOT NULL,
  byte_size         INTEGER NOT NULL,
  mime_type         TEXT NOT NULL DEFAULT 'application/pdf',
  original_filename TEXT,
  uploaded_by       INTEGER REFERENCES users(id),
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalogue_blobs_sha ON catalogue_blobs(sha256);

COMMENT ON TABLE catalogue_blobs IS
  'Datasheet/catalogue file bytes. storage_key matches catalogue_uploads.stored_file_url '
  'and product_catalogue_files.file_url exactly, so the storage driver can be swapped '
  'without touching any referencing row. See server/src/storage/dbStorage.js.';
