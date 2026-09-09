# Applying: chunked RAG pipeline + auto-export + cross-platform db scripts

This is the complete, current state of every file touched across three
changes on top of your last "catalogue portability" commit:

1. Chunked RAG ingestion (chunking at upload, copied to product at publish,
   per-chunk retrieval for matching).
2. `db/catalogue_export.json` written automatically on every publish.
3. `db:migrate` (and every other `db/*.js` script) fixed to be fully
   cross-platform — no `psql` dependency, no reliance on `$VAR` shell
   expansion, and `.env` resolved relative to each script's own location
   instead of whatever directory it happened to be invoked from.

## Option A — apply the patch (try this first)

```bash
git apply full-followup.patch
```

If it fails to apply cleanly (your local tree has drifted from git a few
times already this week), use Option B.

## Option B — copy the files directly

Copy every file in this folder into your project at the matching path,
overwriting what's there:

- `DEPLOY.md`, `package.json`, `server/package.json`
- `db/schema.sql`, `db/exportCatalogue.js`, `db/importCatalogue.js`,
  `db/seed.js`
- `db/migrate.js`, `db/runSql.js` **(new)**
- `db/backfillDatasheetChunks.js` **(new)**
- `db/migrations/003_add_datasheet_chunks.sql` **(new)**
- `server/src/controllers/catalogueUploadsController.js`
- `server/src/controllers/productsController.js`
- `server/src/services/internalDatasheetLookup.js`
- `server/src/services/chunkDatasheet.js` **(new)**

## After applying (either option)

```bash
npm run db:migrate                 # creates every table, including catalogue_uploads
npm run db:backfill-chunks         # only if you have catalogues published before this feature existed
```

## About the "Failed to fetch" error on the Catalogue Manager page

That error is the browser's fetch API saying it couldn't reach the backend
server at `http://localhost:4000` at all — not a database error, not a code
bug in the upload form. It happens when:

- **The backend server isn't running.** `npm run dev --workspace=web` only
  starts the frontend (port 5173, what you see in the browser). The API
  server is a separate process — open a **second terminal** and run
  `npm run dev:server` (or `cd server && npm run dev`) from the repo root.
  Leave both terminals running at the same time.
- **The backend crashed on startup.** Check that second terminal's output
  for an error right after you start it — most commonly a missing/wrong
  `DATABASE_URL` in `.env`, or Postgres not running.
- Once the backend terminal shows something like
  `FM platform server listening on :4000` with no errors, reload the
  Catalogue Manager page and try uploading again.

## One heads-up unrelated to this change

`db/catalogue_export.json` in this repo right now is a snapshot of the
sandbox's test/seed catalogue, not your real published data. The next time
you publish something for real, it's overwritten with your actual catalogue
automatically — just commit and push that as normal from then on.
