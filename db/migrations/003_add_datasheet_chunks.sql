-- db/migrations/003_add_datasheet_chunks.sql
--
-- Adds the chunked-text tables for the internal RAG ingestion pipeline:
-- every catalogue PDF upload is now chunked immediately (catalogue_upload_chunks),
-- and every publish copies those chunks over keyed to the product
-- (product_datasheet_chunks) — see server/src/services/chunkDatasheet.js,
-- catalogueUploadsController.js, and internalDatasheetLookup.js.
--
-- Run this once against an existing database with:
--   psql "$DATABASE_URL" -f db/migrations/003_add_datasheet_chunks.sql
--
-- This ONLY creates the new tables — it does not chunk any already-published
-- products' existing datasheet_text. Run `npm run db:backfill-chunks`
-- (db/backfillDatasheetChunks.js) right after this to populate chunks for
-- catalogues that were published before this feature existed. Until that's
-- run, matching still works — internalDatasheetLookup.js falls back to
-- whole-document search on products.datasheet_text for any product with no
-- rows in product_datasheet_chunks yet.

CREATE TABLE IF NOT EXISTS product_datasheet_chunks (
  id            SERIAL PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_product_datasheet_chunks_product ON product_datasheet_chunks(product_id);
CREATE INDEX IF NOT EXISTS idx_product_datasheet_chunks_fts ON product_datasheet_chunks USING GIN (to_tsvector('english', content));

CREATE TABLE IF NOT EXISTS catalogue_upload_chunks (
  id                    SERIAL PRIMARY KEY,
  catalogue_upload_id   INTEGER NOT NULL REFERENCES catalogue_uploads(id) ON DELETE CASCADE,
  chunk_index           INTEGER NOT NULL,
  content               TEXT NOT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_catalogue_upload_chunks_upload ON catalogue_upload_chunks(catalogue_upload_id);
CREATE INDEX IF NOT EXISTS idx_catalogue_upload_chunks_fts ON catalogue_upload_chunks USING GIN (to_tsvector('english', content));
