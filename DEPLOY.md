# Moving this app to another machine

`git push` / `git pull` only ever moves **code**. Two things this app needs
to actually work are NOT code, so they don't travel with git automatically
unless you do the extra step below:

1. **Your catalogue database rows** (products, categories, extra specs,
   admin upload/review history) — these live in Postgres, and git has no
   idea Postgres exists.
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

After uploading/publishing new catalogue entries in the admin console:

```bash
npm run db:export-catalogue        # writes db/catalogue_export.json
git add db/catalogue_export.json server/uploads/
git commit -m "Update catalogue: <what changed>"
git push
```

## On the machine you're deploying/running the app on

```bash
git pull
npm install
npm run db:migrate                 # only needed once, or after a schema change
npm run db:import-catalogue        # replaces this DB's catalogue tables with the export
```

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
