# Running this app on another machine

## The short version

```bash
git clone <repo>          # or: git pull
npm install
docker compose up -d      # starts Postgres
npm run setup             # env + schema + catalogue data, idempotent
npm run dev:server        # http://localhost:4000
npm run dev:web           # http://localhost:5173
```

`npm run setup` is safe to run any time, including after every pull. It works
out what the database needs and does only that.

---

## Why this used to fail (keep this section — it explains the guards)

Three separate faults produced the same two symptoms — *"SASL:
SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"* and *"the
database is empty again"* — and fixing one never fixed the others.

**1. `.env` is gitignored, so a clone never has one.**
`server/src/config/db.js` read `DATABASE_URL` from a `.env` that didn't exist,
got `undefined`, and handed it to `pg`, which fell back to its defaults with no
password. The SASL message is `pg` complaining about a missing password — it
never mentions the actual problem. Nothing you fixed locally could travel,
because the fix *was* the untracked file.
→ `config/env.js` now creates `.env` from `.env.example` on first run, and
`assertDatabaseUrl()` fails with an instruction instead of that message.

**2. Three db scripts were committed with unresolved merge conflicts.**
`db/migrate.js`, `db/seed.js` and `db/runSql.js` each contained `<<<<<<< HEAD`
markers, which makes them Node syntax errors. `npm run db:migrate` and
`npm run db:seed` crashed before touching Postgres on *every* clone, so the
schema was never created and the baseline catalogue never loaded.
→ Resolved. Also `git config merge.conflictstyle diff3` and check
`git diff --check` before committing; a conflict marker in a committed file is
what turned a one-machine problem into an everyone-machine problem.

**3. An empty export was silently overwriting the real catalogue.**
This is the one that actually destroyed data:

- `catalogueUploadsController.js` calls `runExport()` after every upload,
  publish and reject, best-effort, errors swallowed.
- `runExport()` overwrote `db/catalogue_export.json` with whatever the current
  database held. On a machine whose database was empty — a fresh clone, or one
  just truncated by an import — that wrote 13 empty arrays over the real
  export.
- That file got committed and pushed.
- `db/importCatalogue.js` ran `TRUNCATE ... CASCADE` *before* checking whether
  the dump had any rows, so pulling it wiped the machine that still had data.

One round trip, catalogue gone everywhere, no error anywhere.
→ Three guards, all in code, none of them optional:
  - `exportCatalogue.js` **refuses** to replace a non-empty export with an
    empty one (`--force` to override).
  - `syncCatalogueToGit.js` **refuses** to commit an empty export.
  - `importCatalogue.js` **refuses** to import an empty export, and writes
    `db/.backups/catalogue_before_import_<timestamp>.json` before it truncates
    anything, so any import is undoable.

**Also fixed along the way:** `LOCAL_UPLOAD_DIR=./server/uploads` was being
resolved against `server/`, producing `server/server/uploads`. A machine with a
`.env` stored PDFs in a folder nothing reads; a machine without one used the
fallback and got the right folder. Paths now resolve against the repo root.
`db/package.json` had also been overwritten with a copy of the root
`package.json`, which breaks `npm install`'s workspace resolution.

---

## Publishing catalogue changes (the machine you upload on)

`db/catalogue_export.json` is written automatically at the end of every
publish. To share it:

```bash
npm run catalogue:sync    # export + git add + git commit (refuses if empty)
git push
```

`npm run catalogue:sync` stops with a clear error rather than committing an
empty catalogue. If it does stop, you are either pointed at the wrong database
(check `DATABASE_URL` in `.env`) or nothing has been published yet.

## Receiving catalogue changes (any other machine)

```bash
git pull
npm install
npm run setup
```

`setup` runs pending migrations, then:

| `catalogue_export.json` | this database | what happens |
|---|---|---|
| has rows | anything | import it (after writing a backup) |
| empty | no products | seed the 29-product baseline |
| empty | has products | **leave the database alone** |

That last row is the safeguard. An empty export can no longer destroy a
populated database, whatever order anyone runs things in.

If a datasheet download 404s after a pull, `server/uploads/` didn't come along
with that pull — the PDF bytes travel via git, not via `catalogue_export.json`.

`db:import-catalogue` is a full **replace**, not a merge. If two people publish
catalogue changes on different machines, only one of you should be the source
of truth, or you will overwrite each other.

---

## The actual long-term fix

Everything above is machinery for moving a database around in git, which is
not what git is for. The real fix is to stop having two copies of the data:

- **One Postgres** both machines point at — a cloud instance (Neon, Supabase,
  RDS; free tiers are enough for this) or a box on the internal network. Change
  `DATABASE_URL` in `.env` on both machines and the entire export/import/sync
  flow becomes unnecessary. Nothing else in the code changes.
- **One file store** — `server/src/storage/dbStorage.js` is currently an empty
  stub. Implementing it (PDF bytes in a `bytea` column) or an `s3Storage.js`
  means `STORAGE_DRIVER` in `.env` is the only thing that changes, and PDFs
  stop needing to be committed to git.

Do that and `npm run setup` on a new machine becomes `npm install` plus a
connection string.
