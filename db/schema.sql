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

CREATE TABLE users (
  id           SERIAL PRIMARY KEY,        -- sales engineers / reviewers
  name         TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  role         TEXT NOT NULL DEFAULT 'sales_engineer',  -- 'sales_engineer' | 'manager' | 'admin'
  active       BOOLEAN DEFAULT TRUE
);

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