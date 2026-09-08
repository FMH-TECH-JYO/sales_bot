# Applying: chunked RAG pipeline + auto-export + missing-file error messages

This is the full, up-to-date state of everything from two changes on top of
your last "catalogue portability" fix:

1. Chunked RAG ingestion for catalogue uploads (chunking at upload time,
   copied to the product at publish, per-chunk retrieval for matching).
2. `db/catalogue_export.json` is now written **automatically** at the end
   of every catalogue publish — you no longer run `npm run db:export-catalogue`
   by hand before committing/pushing.
3. The "download datasheet" endpoints (matching page + catalogue review
   screen) now return a clear error instead of crashing if the PDF file is
   missing from `server/uploads/` on this machine.

## Option A — apply the patch (try this first)

From your repo root:

```bash
git apply rag-and-portability-followup.patch
```

If it fails to apply cleanly — likely if any of these files have local
edits that don't match git (we've hit this a couple of times already with
`AdminDashboard.jsx` and `storage/localStorage.js`) — use Option B.

## Option B — copy the files directly

This folder mirrors your repo structure. Copy every file into your project
at the matching path, overwriting what's there:

- `DEPLOY.md`
- `db/schema.sql`
- `db/exportCatalogue.js`
- `db/importCatalogue.js`
- `db/backfillDatasheetChunks.js` **(new)**
- `db/migrations/003_add_datasheet_chunks.sql` **(new)**
- `package.json`
- `server/src/controllers/catalogueUploadsController.js`
- `server/src/controllers/productsController.js`
- `server/src/services/internalDatasheetLookup.js`
- `server/src/services/chunkDatasheet.js` **(new)**

## After applying (either option)

```bash
npm run db:migrate                 # creates product_datasheet_chunks + catalogue_upload_chunks
npm run db:backfill-chunks         # chunks any already-published catalogues from before this feature
```

Restart the server. From now on:

- Every catalogue PDF you upload is chunked immediately; publishing copies
  those chunks onto the product for matching to search.
- Every publish also rewrites `db/catalogue_export.json` for you — after
  publishing, all you do is `git add db/catalogue_export.json server/uploads/
  && git commit && git push`. No manual export step.
- Pulling this app onto a new machine is `git pull && npm install && npm run
  db:migrate && npm run db:import-catalogue` — no re-uploading catalogues
  through the admin UI. If "download datasheet" ever 404s with a "missing
  from this server's storage" message after a pull, it means
  `server/uploads/` itself didn't come along with that pull (check
  `git status`/`git log -- server/uploads` there) — that's the one thing the
  database import alone can't fix, since the PDF bytes only travel via git.

## One heads-up unrelated to this change

`db/catalogue_export.json` in this repo right now is a snapshot of the
sandbox's test/seed catalogue, not your real published data. The very next
time you publish something for real, it'll be overwritten with your actual
catalogue automatically — just commit and push that as normal from then on.
