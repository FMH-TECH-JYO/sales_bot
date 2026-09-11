-- db/migrations/005_spec_table_order.sql
--
-- The offer's specification table has to print in the order the datasheet
-- prints it: Model, Type, Mounting, Nominal size, Dial, Casing & Bezel,
-- Movement, Case Filling, Lens, Pointer, Sealing Ring, Blow Out Disc, Vent
-- Plug. Alphabetical or insertion-id order reads as nonsense to an engineer
-- checking a quote against a datasheet.
--
-- extra_specs already arrives from extraction as an ordered array; this column
-- is where that order survives the round-trip through Postgres. Without it,
-- `SELECT ... FROM product_extra_spec` returns rows in whatever order the
-- planner feels like, which is stable enough to look correct in testing and
-- wrong in production.
--
-- Idempotent; safe to re-run.

ALTER TABLE product_extra_spec ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- This table is keyed on (product_id, label) and has no id column, so there is
-- no insertion order to recover. Existing rows get a stable alphabetical order
-- rather than the planner's whim; they take on the real datasheet order the
-- next time their product is republished from the review screen.
WITH ordered AS (
  SELECT product_id, label,
         (ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY label) - 1) AS rn
    FROM product_extra_spec
   WHERE sort_order IS NULL
)
UPDATE product_extra_spec pes
   SET sort_order = ordered.rn
  FROM ordered
 WHERE pes.product_id = ordered.product_id AND pes.label = ordered.label;

CREATE INDEX IF NOT EXISTS idx_product_extra_spec_order
  ON product_extra_spec(product_id, sort_order);
