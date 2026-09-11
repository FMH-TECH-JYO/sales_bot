-- db/migrations/004_persistence_and_pricing.sql
--
-- Everything needed to (a) actually persist enquiries/matches/offers, and
-- (b) hold the pricing model agreed in claude/product-spec-enquiry-to-offer.md.
--
-- Until now nothing in the app wrote a single row to enquiries, matches,
-- offers or offer_line_items — the tables were designed but never used, so
-- closing the browser tab erased the enquiry. This migration adds the columns
-- those writes need; the writes themselves live in
-- server/src/services/persistEnquiry.js and offersController.js.
--
-- Idempotent (IF NOT EXISTS throughout) — safe to re-run, and safe on a
-- database created from an older schema.sql. A fresh `npm run db:migrate`
-- installs schema.sql, which already includes all of this, and records this
-- file as applied without running it.

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
