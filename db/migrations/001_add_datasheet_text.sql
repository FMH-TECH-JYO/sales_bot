-- db/migrations/001_add_datasheet_text.sql
--
-- Run this against an EXISTING database that was created before this
-- migration was added (a fresh `npm run db:migrate` from schema.sql
-- already includes this column/index and doesn't need it).
--
--   psql "$DATABASE_URL" -f db/migrations/001_add_datasheet_text.sql
--
-- Adds products.datasheet_text (full text of the current published
-- datasheet, used only for internal full-text lookup in matchEnquiry.js —
-- see the column comment in schema.sql) and backfills it for any product
-- that already has a published catalogue file, plus the search index.

ALTER TABLE products ADD COLUMN IF NOT EXISTS datasheet_text TEXT;

UPDATE products p
SET datasheet_text = cu.raw_text
FROM product_catalogue_files f
JOIN catalogue_uploads cu ON cu.stored_file_url = f.file_url
WHERE f.product_id = p.id
  AND f.is_current = TRUE
  AND p.datasheet_text IS NULL
  AND cu.raw_text IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_datasheet_fts
  ON products USING GIN (to_tsvector('english', coalesce(datasheet_text, '')));
