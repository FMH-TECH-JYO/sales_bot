# Moving this app to another machine

`git push` / `git pull` only ever moves **code**. Two things this app needs
to actually work are NOT code, so they don't travel with git automatically
unless you do the extra step below:

1. **Your catalogue database rows** (products, categories, extra specs,
   the chunked RAG text used for matching, admin upload/review history) —
   these live in Postgres, and git has no idea Postgres exists.
2. **The actual datasheet PDF files** admins have uploaded — these live on
   disk under `server/uploads/`, and (unlike most projects) this repo
   commits them directly to git rather than ignoring them, since there's
   no shared/cloud file storage configured. Keep them checked in.

If you skip step 1 below, the app runs but shows **no catalogue products**
(a fresh database only has whatever `npm run db:seed` puts there — the
baseline 29-product demo seed, not your real published catalogue). If you
skip committing `server/uploads/`, products will exist in the database but
**"View Catalogue" / datasheet download will fail** with a file-not-found
error, because the database row points at a PDF that isn't there.

## On the machine you publish catalogue changes from

`db/catalogue_export.json` is now written **automatically** every time you
publish a catalogue in the admin console (see `runExport()` called at the
end of `publishCatalogue()` in `catalogueUploadsController.js`) — you don't
need to remember to run the export script by hand anymore. All that's left
after publishing is to commit and push:

```bash
git add db/catalogue_export.json server/uploads/
git commit -m "Update catalogue: <what changed>"
git push
```

(`npm run db:export-catalogue` still exists if you ever need to force a
refresh outside of publishing — e.g. after editing the database directly —
but the normal publish-a-catalogue flow no longer needs it.)

## On the machine you're deploying/running the app on

This is the "I pulled the code onto another system, I shouldn't have to
re-upload all the catalogues again" step — running these three commands is
the whole thing, no re-uploading through the admin UI required:

```bash
git pull
npm install
npm run db:migrate                 # only needed once, or after a schema change
npm run db:import-catalogue        # replaces this DB's catalogue tables with the export
```

After that, every product, every chunk of RAG text, and every original PDF
(from `server/uploads/`, pulled with the rest of the code) is exactly as it
was on the machine you published from — nothing needs re-uploading. If a
product's "download datasheet" ever 404s with a "missing from this server's
storage" message after a pull, it means `server/uploads/` didn't actually
come along with that pull (check `git status`/`git log` on that folder) —
that's the one thing importing the database alone can't fix, since the PDF
bytes themselves only travel via git, not via `catalogue_export.json`.

## What happens on every catalogue upload (the RAG ingestion pipeline)

Uploading a PDF in the admin console does the full pipeline immediately,
not just at publish time:

1. The PDF is saved to storage (`server/uploads/`) and its text extracted.
2. That text is **chunked** (`server/src/services/chunkDatasheet.js` —
   deterministic paragraph-aware splitting, no LLM) and stored in
   `catalogue_upload_chunks`, one row per chunk.
3. If a category was picked, the LLM drafts the structured product fields
   for review, same as before.

On **publish**, those chunks are copied over keyed to the final product id
(`product_datasheet_chunks`), fully replacing any previous chunks for that
product — this is what `internalDatasheetLookup.js` actually searches
(per-chunk full-text ranking) when matching finds a spec an enquiry asked
about that isn't in any structured field. The original PDF itself is never
touched or replaced by this — it stays in `server/uploads/` and every
published version is kept in `product_catalogue_files` — chunking only
affects the searchable text copy used for matching.

Both chunk tables are included in `db:export-catalogue` /
`db:import-catalogue`, so the RAG index travels with the rest of the
catalogue across machines — you don't need to re-chunk anything after a
`git pull` + `db:import-catalogue`. The one exception is a database that
had catalogues published **before** this chunking pipeline existed: run
`npm run db:backfill-chunks` once to chunk their existing `datasheet_text`
retroactively (matching still works without it in the meantime — lookups
just fall back to whole-document search for those specific products until
they're backfilled or re-published).

`db:import-catalogue` is a full **replace**, not a merge — it's meant for
"make this machine match the one I publish from," not for combining
catalogues edited independently on two machines. If two people are
publishing catalogue changes on different machines, only one of you should
run `db:export-catalogue` before each push, or you'll overwrite each
other's work on import.

## Longer-term

The actual fix for a real production deployment is to stop duplicating
data across machines at all: one Postgres instance and one uploads folder
that every environment reads from (a real DB host + object storage like
S3, swapped in via `STORAGE_DRIVER` in `server/src/storage/`). The
export/import scripts here are a stand-in for that until this app has a
real server to live on.
