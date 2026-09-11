-- db/migrations/002_drop_won_lost_tracking.sql
--
-- Run against an EXISTING database created before this migration:
--   psql "$DATABASE_URL" -f db/migrations/002_drop_won_lost_tracking.sql
-- (A fresh `npm run db:migrate` from schema.sql already reflects this.)
--
-- This app doesn't track anything past an offer being generated/downloaded
-- — no won/lost outcome. Drops the now-unused columns from `offers` (the
-- `offers` table itself isn't currently written to by the app, so this is
-- safe even on a live DB) and normalizes any stray 'won'/'lost' status rows
-- back to 'generated' before dropping the columns those relied on.

UPDATE offers SET status = 'generated' WHERE status IN ('won', 'lost', 'sent');

ALTER TABLE offers DROP COLUMN IF EXISTS won_at;
ALTER TABLE offers DROP COLUMN IF EXISTS lost_at;
ALTER TABLE offers DROP COLUMN IF EXISTS lost_reason;

-- Same cleanup for enquiries.stage, if any rows ever reached these values.
UPDATE enquiries SET stage = 'offer_sent' WHERE stage IN ('won', 'lost', 'no_response');
