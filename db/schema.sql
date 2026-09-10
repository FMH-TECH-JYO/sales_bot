-- ============================================================================
-- Forbes Marshall Enquiry Intelligence Platform — Database Schema
-- Target: PostgreSQL (production). Compatible with SQLite for Phase 0 local
-- prototyping with minor type substitutions noted inline (see comments).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- CATALOGUE (seeded from products_seed.json — do not hand-author this data,
-- load it via the seed script; products_seed.json is the source of truth)
-- ---------------------------------------------------------------------------

CREATE TABLE categories (
  id            TEXT PRIMARY KEY,        -- e.g. 'pressure_switch'
  label         TEXT NOT NULL,
  unit          TEXT NOT NULL            -- display unit for range filters, e.g. 'bar', '°C', 'mm'
);

CREATE TABLE products (
  id                TEXT PRIMARY KEY,     -- product model code, e.g. 'WP', 'FMPT-7000'; '—' not allowed as id, use a synthetic id for no-code items (see note below)
  model             TEXT NOT NULL,        -- display model, may be '—' if no catalogue code published
  family            TEXT NOT NULL,
  category_id       TEXT NOT NULL REFERENCES categories(id),
  blurb             TEXT NOT NULL,
  val_min           NUMERIC,
  val_max           NUMERIC,
  temp_max          NUMERIC,
  accuracy          TEXT,
  output_type       TEXT NOT NULL,        -- 'switch' | '4-20mA' | 'hart' | 'visual'
  hazardous         TEXT NOT NULL,        -- 'safe' | 'flameproof' | 'both'
  connection        TEXT,
  no_code           BOOLEAN DEFAULT FALSE,-- true if no catalogue order code exists (see products_seed.json)
  datasheet_text    TEXT,                  -- full parsed text of the CURRENT published datasheet PDF, copied from
                                            -- catalogue_uploads.raw_text at publish time. Used ONLY for internal
                                            -- full-text retrieval (matchEnquiry.js) when a spec the enquiry asked
                                            -- about isn't in any of the structured columns/extra specs above —
                                            -- never sent whole to the LLM, never used for anything customer-facing.
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Postgres built-in full-text search (no extension required) over each
-- product's own datasheet text — this is the "internal catalogue RAG"
-- retrieval path, deliberately NOT vector/embedding-based so it needs
-- nothing beyond stock Postgres.
CREATE INDEX idx_products_datasheet_fts ON products USING GIN (to_tsvector('english', coalesce(datasheet_text, '')));
-- NOTE: two temp_switch entries in products_seed.json have model:'—' (no dedicated code).
-- Assign them synthetic ids at seed time, e.g. 'TEMP-SW-WEATHERPROOF' / 'TEMP-SW-FLAMEPROOF'.

-- Chunked datasheet text for the internal RAG retrieval pipeline
-- (server/src/services/chunkDatasheet.js + internalDatasheetLookup.js).
-- products.datasheet_text above stays as the raw, unsplit archive of what
-- was published (kept for re-chunking / debugging); THIS table is what
-- matchEnquiry.js actually searches — one row per chunk of that product's
-- CURRENT published datasheet, so full-text ranking works on individual
-- passages instead of one giant per-product blob. Fully replaced (delete +
-- reinsert) every time a catalogue is (re-)published — see publishCatalogue()
-- in catalogueUploadsController.js.
CREATE TABLE product_datasheet_chunks (
  id            SERIAL PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_product_datasheet_chunks_product ON product_datasheet_chunks(product_id);
CREATE INDEX idx_product_datasheet_chunks_fts ON product_datasheet_chunks USING GIN (to_tsvector('english', content));

CREATE TABLE product_industries (
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  industry     TEXT NOT NULL,
  PRIMARY KEY (product_id, industry)
);

CREATE TABLE product_keywords (
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  keyword      TEXT NOT NULL,
  PRIMARY KEY (product_id, keyword)
);

CREATE TABLE product_extra_spec (
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,             -- e.g. 'Switch contact options'
  value        TEXT NOT NULL,
  PRIMARY KEY (product_id, label)
);

CREATE TABLE product_deviations (
  id           SERIAL PRIMARY KEY,        -- SQLite: INTEGER PRIMARY KEY AUTOINCREMENT
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'caveat'  -- 'hard_mismatch' | 'partial_fit' | 'caveat'
);

CREATE TABLE product_order_codes (
  id           SERIAL PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  skeleton     TEXT,                      -- e.g. 'WP–Mounting–ConnSize–...'
  example      TEXT
);

CREATE TABLE product_order_code_segments (
  id             SERIAL PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  segment_no     TEXT NOT NULL,           -- '1', '2', ... or named segments like 'Sensor', '/Options'
  parameter      TEXT NOT NULL,           -- e.g. 'Mounting'
  option_code    TEXT NOT NULL,           -- e.g. '1'
  option_label   TEXT NOT NULL            -- e.g. 'Direct bottom'
);

CREATE TABLE product_range_tables (
  id           SERIAL PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title        TEXT,                      -- e.g. 'WP / FP range table'
  note         TEXT,
  code         TEXT NOT NULL,             -- e.g. 'A'
  unit         TEXT NOT NULL,             -- e.g. 'mmWC'
  range_text   TEXT NOT NULL              -- e.g. '-200 to +200'
);

CREATE TABLE product_catalogue_files (
  id           SERIAL PRIMARY KEY,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_url     TEXT NOT NULL,             -- object storage key/URL
  version      INTEGER NOT NULL DEFAULT 1,
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_current   BOOLEAN DEFAULT TRUE
);

-- ---------------------------------------------------------------------------
-- CRM / ENQUIRY TRACKING (for management reporting)
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id              SERIAL PRIMARY KEY,
  company_name    TEXT NOT NULL,
  industry        TEXT,
  region          TEXT,
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- IMPORTANT — the contract between this file and db/migrations/:
-- db/migrate.js installs THIS FILE on a fresh database and then marks every
-- migration as already applied, on the stated assumption that schema.sql is
-- the current shape. So anything a migration adds must ALSO be added here, or
-- a brand-new deployment gets the migration recorded as done without ever
-- running it, and the objects simply do not exist.
--
-- That is not hypothetical: migration 007 was written and this file was not
-- updated, so a fresh database came up with `007_auth.sql` recorded as applied,
-- no sessions table, and no password_hash column — an application that cannot
-- authenticate anyone, on a database that reports itself fully migrated.
-- server/test/schemaConsistency.test.js now fails when the two drift apart.

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,       -- sales engineers / reviewers
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL DEFAULT 'sales_engineer',  -- 'sales_engineer' | 'manager' | 'admin'
  active        BOOLEAN DEFAULT TRUE,

  -- 007_auth.sql. Nullable on purpose: a row with no hash CANNOT sign in, which
  -- is the correct state for accounts created before authentication existed.
  -- Set one with `npm run user:create`. There is deliberately no default
  -- account and no default password.
  password_hash TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP,

  -- Failed-login throttling lives on the row, not in memory, so it survives a
  -- restart and is shared across processes. An attacker who can restart the
  -- server must not get a fresh allowance of guesses.
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMP
);

-- Email is compared case-insensitively everywhere, so 'Admin@fm.com' and
-- 'admin@fm.com' must not be able to exist as two separate logins.
CREATE UNIQUE INDEX users_email_lower_idx ON users (LOWER(email));

-- 007_auth.sql. Opaque server-side sessions rather than JWTs: a JWT cannot be
-- revoked before it expires without a server-side deny list, which costs the
-- same as this table and buys nothing. Twenty to thirty people on one Postgres
-- do not need stateless auth; they need someone's access to end immediately
-- when they leave. Only the SHA-256 of the token is stored, so a database dump
-- contains nothing replayable.
CREATE TABLE sessions (
  id           SERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at   TIMESTAMP,                 -- set on logout; the row is kept for audit
  user_agent   TEXT,
  ip           TEXT
);

CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE enquiries (
  id                SERIAL PRIMARY KEY,
  customer_id       INTEGER REFERENCES customers(id),
  source_file_url   TEXT,                 -- uploaded file in object storage, null if pasted text
  source_type       TEXT NOT NULL,        -- 'pdf_native' | 'pdf_scanned' | 'docx' | 'xlsx' | 'csv' | 'text'
  source_quality    TEXT,                 -- 'clean_text' | 'native_pdf' | 'ocr_pdf' | 'table'
  raw_text          TEXT,                 -- normalized plain text after parsing
  uploaded_by       INTEGER REFERENCES users(id),
  assigned_to       INTEGER REFERENCES users(id),
  stage             TEXT NOT NULL DEFAULT 'new',  -- see stage list below
  priority          TEXT DEFAULT 'normal',        -- 'low' | 'normal' | 'high'
  stage_entered_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  uploaded_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Valid stage values (enforce in application layer or CHECK constraint):
--   'new' -> 'extracted' -> 'reviewed' -> 'matched' -> 'offer_drafted' -> 'offer_sent'
-- 'offer_sent' is the last tracked stage — this app doesn't track what
-- happens to an enquiry after the offer is generated/downloaded (no
-- won/lost outcome). 'abandoned' is reachable from any stage before that.

CREATE TABLE enquiry_stage_history (
  id            SERIAL PRIMARY KEY,
  enquiry_id    INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  from_stage    TEXT,
  to_stage      TEXT NOT NULL,
  changed_by    INTEGER REFERENCES users(id),
  changed_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE enquiry_line_items (
  id                    SERIAL PRIMARY KEY,
  enquiry_id            INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  category_id           TEXT REFERENCES categories(id),
  extracted_json        JSONB NOT NULL,   -- SQLite: TEXT, store JSON as string
  confidence_json       JSONB,            -- per-field confidence scores
  extraction_provider   TEXT,             -- 'local-ollama-llama3.2-1b' | 'cloud-claude-haiku' | etc.
  reviewed_by           INTEGER REFERENCES users(id),
  reviewed_at           TIMESTAMP,
  human_corrected       BOOLEAN DEFAULT FALSE
);

CREATE TABLE extraction_feedback (
  id                SERIAL PRIMARY KEY,
  line_item_id      INTEGER NOT NULL REFERENCES enquiry_line_items(id) ON DELETE CASCADE,
  field             TEXT NOT NULL,        -- e.g. 'hazardous', 'val_max'
  model_value       TEXT,                 -- what the LLM/rules pipeline produced
  corrected_value   TEXT,                 -- what the human reviewer set it to
  corrected_by      INTEGER REFERENCES users(id),
  corrected_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- This table doubles as: (a) the audit trail for what changed and why,
-- and (b) the labelled dataset for the optional Phase 1.5 LoRA fine-tune.

CREATE TABLE matches (
  id                SERIAL PRIMARY KEY,
  line_item_id      INTEGER NOT NULL REFERENCES enquiry_line_items(id) ON DELETE CASCADE,
  product_id        TEXT NOT NULL REFERENCES products(id),
  percent_match     NUMERIC NOT NULL,     -- 0-100
  criteria_scores   JSONB NOT NULL,       -- {"range":1.0,"hazard":1.0,"output":1.0,"temp":0.5,"media":0.5,"connection":0.5}
  deviations_json    JSONB,               -- snapshot of deviations shown at match time (catalogue may change later)
  rank              INTEGER NOT NULL,     -- 1 = best match for this line item
  computed_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE offers (
  id            SERIAL PRIMARY KEY,
  enquiry_id    INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 1,
  customer_json JSONB,                    -- snapshot of customer details at offer time
  terms_json    JSONB,                    -- payment terms, validity, delivery
  status        TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'generated' — nothing past this is tracked
  pdf_url       TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE offer_line_items (
  id            SERIAL PRIMARY KEY,
  offer_id      INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  match_id      INTEGER REFERENCES matches(id),
  product_id    TEXT NOT NULL REFERENCES products(id),
  quantity      INTEGER NOT NULL DEFAULT 1,
  unit_price    NUMERIC,
  notes         TEXT
);

CREATE TABLE audit_log (
  id            SERIAL PRIMARY KEY,
  entity_type   TEXT NOT NULL,            -- 'enquiry' | 'line_item' | 'match' | 'offer' | 'product'
  entity_id     TEXT NOT NULL,
  actor         INTEGER REFERENCES users(id),
  action        TEXT NOT NULL,            -- 'create' | 'update' | 'stage_change' | 'regenerate' | 'correct_extraction'
  diff_json     JSONB,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- CATALOGUE INGESTION PIPELINE  ***NEW — added for the "upload a catalogue"
-- workflow. This is what lets a new product be added by uploading a PDF and
-- publishing it, with no code change or redeploy.
-- ---------------------------------------------------------------------------

CREATE TABLE catalogue_uploads (
  id                 SERIAL PRIMARY KEY,
  original_filename  TEXT NOT NULL,
  stored_file_url    TEXT NOT NULL,       -- wherever storage.js put it (local path or S3 key)
  file_hash          TEXT,                -- sha256 of file content, used to detect re-uploads of the same PDF
  mime_type          TEXT,
  category_id        TEXT REFERENCES categories(id),   -- set by admin, or left null for the LLM to suggest
  status             TEXT NOT NULL DEFAULT 'uploaded',
  -- status lifecycle: 'uploaded' -> 'parsing' -> 'drafted' -> 'in_review' -> 'published' | 'rejected'
  raw_text           TEXT,                -- parsed PDF text, kept for re-extraction/debugging
  extracted_json     JSONB,               -- draft product record — same shape as a `products` row, editable before publish
  extraction_provider TEXT,               -- 'local-ollama-llama3.2-1b' | etc — which model produced the draft
  product_id         TEXT REFERENCES products(id),      -- set once published; null until then
  uploaded_by        INTEGER REFERENCES users(id),
  uploaded_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reviewed_by        INTEGER REFERENCES users(id),
  reviewed_at        TIMESTAMP,
  published_at       TIMESTAMP
);

CREATE INDEX idx_catalogue_uploads_status ON catalogue_uploads(status);

-- Chunked text produced the moment a catalogue PDF is uploaded (before it's
-- even reviewed/published) — this is the "every upload immediately feeds
-- the RAG pipeline with chunking" step, done in uploadCatalogue() right
-- after text extraction. On publish, these rows are copied into
-- product_datasheet_chunks against the final product_id (see
-- publishCatalogue()) — kept here too so the chunked text always exists
-- for review/debugging even for uploads that never get published.
CREATE TABLE catalogue_upload_chunks (
  id                    SERIAL PRIMARY KEY,
  catalogue_upload_id   INTEGER NOT NULL REFERENCES catalogue_uploads(id) ON DELETE CASCADE,
  chunk_index           INTEGER NOT NULL,
  content               TEXT NOT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_catalogue_upload_chunks_upload ON catalogue_upload_chunks(catalogue_upload_id);
CREATE INDEX idx_catalogue_upload_chunks_fts ON catalogue_upload_chunks USING GIN (to_tsvector('english', content));

-- ---------------------------------------------------------------------------
-- Indexes worth adding immediately (query patterns from the dashboard)
-- ---------------------------------------------------------------------------
CREATE INDEX idx_enquiries_stage ON enquiries(stage);
CREATE INDEX idx_enquiries_assigned_to ON enquiries(assigned_to);
CREATE INDEX idx_stage_history_enquiry ON enquiry_stage_history(enquiry_id);
CREATE INDEX idx_line_items_enquiry ON enquiry_line_items(enquiry_id);
CREATE INDEX idx_matches_line_item ON matches(line_item_id);
CREATE INDEX idx_matches_product ON matches(product_id);
CREATE INDEX idx_products_category ON products(category_id);

-- ---------------------------------------------------------------------------
-- SQLite compatibility notes (Phase 0 local prototype):
--   - SERIAL PRIMARY KEY  -> INTEGER PRIMARY KEY AUTOINCREMENT
--   - JSONB               -> TEXT (store/parse JSON in application code)
--   - TIMESTAMP DEFAULT CURRENT_TIMESTAMP -> works as-is in SQLite
--   - No native BOOLEAN in SQLite -> use INTEGER 0/1 (most drivers handle this transparently)
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- Included from db/migrations/004_persistence_and_pricing.sql so a fresh
-- install has these without needing the migration replayed. All idempotent.
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- Pricing: base price per product + adders per selectable option
-- ---------------------------------------------------------------------------
-- unit_price = products.base_price
--            + SUM(price_delta of each selected order-code segment option)
--            + price_delta of the selected range row
-- Never stored as a product total: the price depends on the configuration.

ALTER TABLE products ADD COLUMN IF NOT EXISTS base_price       NUMERIC;
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_currency   TEXT DEFAULT 'INR';
ALTER TABLE products ADD COLUMN IF NOT EXISTS price_updated_at TIMESTAMP;

-- Accessories (snubber, syphon, manifold, adapter, diaphragm seal, gauge cock)
-- are ordinary catalogue products so they carry specs, order codes and prices
-- like anything else — they are just never the PRIMARY item on an offer. The
-- LLM picks them from the enquiry text; this flag keeps them out of the main
-- match candidate list.
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_accessory     BOOLEAN DEFAULT FALSE;

ALTER TABLE product_order_code_segments ADD COLUMN IF NOT EXISTS price_delta NUMERIC DEFAULT 0;
ALTER TABLE product_range_tables        ADD COLUMN IF NOT EXISTS price_delta NUMERIC DEFAULT 0;

-- Who changed a price and when. Cheaper than full price-list versioning, and
-- enough to answer "what was this priced at in March".
CREATE TABLE IF NOT EXISTS price_history (
  id          SERIAL PRIMARY KEY,
  product_id  TEXT REFERENCES products(id) ON DELETE CASCADE,
  segment_id  INTEGER REFERENCES product_order_code_segments(id) ON DELETE CASCADE,
  field       TEXT NOT NULL DEFAULT 'base_price',
  old_value   NUMERIC,
  new_value   NUMERIC,
  changed_by  INTEGER REFERENCES users(id),
  changed_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id);

-- ---------------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------------
ALTER TABLE offers ADD COLUMN IF NOT EXISTS offer_no   TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS currency   TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE offers ADD COLUMN IF NOT EXISTS is_export  BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_offer_no_key') THEN
    ALTER TABLE offers ADD CONSTRAINT offers_offer_no_key UNIQUE (offer_no);
  END IF;
END $$;

-- Human-readable offer number: FM/<year>/<0001>. App formats it; the sequence
-- guarantees uniqueness under concurrency without a SELECT MAX race.
CREATE SEQUENCE IF NOT EXISTS offer_no_seq START 1;

-- ---------------------------------------------------------------------------
-- Offer line items
-- ---------------------------------------------------------------------------
-- The real techno-commercial offer quotes the SAME product more than once at
-- different ranges/tags (see the sample: one gauge, two ranges, 5 off each),
-- and hangs accessories off a parent item ("ACCESSORIES FOR ABOVE"). Hence
-- tag_no/range_text per row and a self-referencing parent.

ALTER TABLE offer_line_items ADD COLUMN IF NOT EXISTS parent_line_item_id INTEGER REFERENCES offer_line_items(id) ON DELETE CASCADE;
ALTER TABLE offer_line_items ADD COLUMN IF NOT EXISTS tag_no        TEXT;
ALTER TABLE offer_line_items ADD COLUMN IF NOT EXISTS range_text    TEXT;
ALTER TABLE offer_line_items ADD COLUMN IF NOT EXISTS order_code    TEXT;
ALTER TABLE offer_line_items ADD COLUMN IF NOT EXISTS config_json   JSONB;
ALTER TABLE offer_line_items ADD COLUMN IF NOT EXISTS discount_pct  NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE offer_line_items ADD COLUMN IF NOT EXISTS line_no       INTEGER;
-- Snapshot of the spec rows rendered into the document, so a reprint of an old
-- offer shows what was quoted then, not what the catalogue says today.
ALTER TABLE offer_line_items ADD COLUMN IF NOT EXISTS specs_json    JSONB;

CREATE INDEX IF NOT EXISTS idx_offer_line_items_parent  ON offer_line_items(parent_line_item_id);
CREATE INDEX IF NOT EXISTS idx_offer_line_items_product ON offer_line_items(product_id);

-- ---------------------------------------------------------------------------
-- Enquiries — link an enquiry line item back to the offer line it became,
-- and index the columns the analytics screens will actually filter on.
-- ---------------------------------------------------------------------------
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS customer_name TEXT;   -- before a customers row exists
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS source_filename TEXT;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS split_method  TEXT;   -- how the file was split into items

ALTER TABLE enquiry_line_items ADD COLUMN IF NOT EXISTS line_index   INTEGER;
ALTER TABLE enquiry_line_items ADD COLUMN IF NOT EXISTS source_excerpt TEXT;
ALTER TABLE enquiry_line_items ADD COLUMN IF NOT EXISTS source_ref   TEXT;
ALTER TABLE enquiry_line_items ADD COLUMN IF NOT EXISTS tag_no       TEXT;

CREATE INDEX IF NOT EXISTS idx_enquiries_uploaded_at ON enquiries(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_enquiry_line_items_enquiry ON enquiry_line_items(enquiry_id);
CREATE INDEX IF NOT EXISTS idx_matches_product_rank ON matches(product_id, rank);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);

-- An offer normally comes from an enquiry, but an engineer may also quote
-- something walked in over the phone. Relax the hard link so offers can be
-- persisted either way; the enquiry_id is still set whenever we have one.
ALTER TABLE offers ALTER COLUMN enquiry_id DROP NOT NULL;

-- from db/migrations/005_spec_table_order.sql
ALTER TABLE product_extra_spec ADD COLUMN IF NOT EXISTS sort_order INTEGER;
CREATE INDEX IF NOT EXISTS idx_product_extra_spec_order ON product_extra_spec(product_id, sort_order);
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
