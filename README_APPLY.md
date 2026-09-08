# sales_bot changes — three rounds combined

1. Multi-enquiry Excel/PDF splitting, per-enquiry matching, requested-vs-
   actual + sources in the UI.
2. Web-search fallback removed (internal deployment). Replaced with
   RTD/Indicator/Temperature-gauge categories, synonym + LLM-constrained
   category detection, extra_specs (family-specific attributes) flowing
   through catalogue upload -> matching, an internal Postgres full-text
   datasheet search as the "look beyond structured fields" fallback, and a
   deterministic "clarifications needed" panel.
3. Catalogue portability fix + won/lost tracking removed:
   - server/uploads/ is no longer gitignored — commit your real PDF files.
   - db/exportCatalogue.js / db/importCatalogue.js move your catalogue
     DATABASE rows between machines (git never carries Postgres data on
     its own). See DEPLOY.md for the full workflow.
   - Admin dashboard no longer shows won/lost (it was mock-only and
     implied tracking this app doesn't do — nothing past offer download is
     tracked). offers.won_at/lost_at/lost_reason dropped from the schema.

NOTE: db/catalogue_export.json is intentionally NOT included here — that
file is a snapshot of MY test database (seed data only), not your real
catalogue. Once these files are in place, generate your own by running
`npm run db:export-catalogue` against your own real database.

Same directory layout as the sales_bot repo root — copy these over your
working copy, or apply the included patch instead.

## Option A — copy files directly
Copy this folder's contents into your sales_bot repo root, overwriting the
matching paths (git will show them as modified/new — review with `git diff`
before committing).

## Option B — apply as a patch
From your sales_bot repo root:
    git checkout -b feature/multi-enquiry-rag-matching
    git apply /path/to/multi-enquiry-rag-matching.patch
(The patch is provided alongside this zip, not inside it.)

## After applying
1. `npm install` from the repo root (adds the `xlsx` dependency).
2. If you have an existing database (not a fresh install), run both:
       psql "$DATABASE_URL" -f db/migrations/001_add_datasheet_text.sql
       psql "$DATABASE_URL" -f db/migrations/002_drop_won_lost_tracking.sql
   A brand-new `npm run db:migrate` (from schema.sql) already includes both.
3. Re-run `npm run db:seed` to pick up the 3 new categories (rtd,
   indicator, temperature_gauge) — safe to re-run, idempotent, won't touch
   your real published products.
4. Read DEPLOY.md — it's now the actual answer to "why did my catalogue
   disappear when I pulled this on another machine."

## What changed (grouped)
Multi-enquiry matching:
- server/src/services/enquiryFileParser.js, splitEnquiries.js (new)
- server/src/controllers/enquiriesController.js, routes/enquiries.js, middleware/uploadEnquiryFile.js (new)

Internal-only matching intelligence:
- server/src/services/categoryAliases.js, categoryClassifier.js (new)
- server/src/services/internalDatasheetLookup.js (new — replaces the deleted webLookup.js)
- server/src/services/matchEnquiry.js, productDraftSchema.js, extractProductDraft.js
- server/src/controllers/catalogueUploadsController.js
- web/src/pages/CatalogueManager.jsx (extra_specs editing)

Catalogue portability + admin dashboard:
- db/exportCatalogue.js, importCatalogue.js (new), DEPLOY.md (new)
- db/migrations/001_add_datasheet_text.sql, 002_drop_won_lost_tracking.sql (new)
- db/schema.sql, db/products_seed.json, .gitignore, package.json
- web/src/pages/AdminDashboard.jsx, lib/mockData.js

UI throughout:
- web/src/api.js, pages/ChatPage.jsx, pages/MatchingPage.jsx, pages/OfferPage.jsx, index.css
