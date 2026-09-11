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

---

# Production deployment

Everything above is the development workflow. This section is what changes when
real users are on it.

## First: create an administrator

There is **no default account and no default password.** A well-known
admin/admin on every deployment is the most reliable way for an application to
be taken over, so the first account is created deliberately:

```bash
npm run user:create -- --email you@forbesmarshall.com --name "Your Name" --role admin --generate
```

`--generate` prints a strong random password once and never again. Without it
you are prompted, and the password is not echoed. The password is never taken
as a command-line argument on purpose: `argv` is visible to every other process
on the machine through `ps`, and it lands in your shell history.

Re-running for an existing address resets that account's password and signs out
all of its sessions, so it doubles as "I locked myself out". After that, further
accounts are created from the admin UI or `POST /auth/users`.

Roles are `sales_engineer`, `manager`, `admin`. There is no hierarchy in the
code — each route lists every role that may call it — because implicit
hierarchies are where privilege-escalation bugs hide.

## Environment

Beyond `DATABASE_URL`, production needs:

| Variable | Set it to | Why |
|---|---|---|
| `NODE_ENV` | `production` | Turns on Secure cookies and disables the rate-limiter escape hatch. |
| `CORS_ORIGINS` | *empty*, or the site serving the frontend | Empty is correct when Express serves `web/dist` itself — there is then no cross-origin call to permit. Set it only if the frontend is deployed separately. |
| `TRUST_PROXY` | `1` behind nginx or a platform router; **empty otherwise** | Without it, `req.ip` is the proxy and the rate limiter treats every user as one client. With it and *no* proxy in front, a client can spoof `X-Forwarded-For` and escape rate limiting entirely. |
| `STORAGE_DRIVER` | `db` | `local` puts datasheets on one instance's disk: lost when the container is replaced, invisible to any other replica. This is the "database is empty again" problem in a new costume. |
| `COOKIE_SAMESITE` | leave unset | Only needed if the app and the API are on different sites, and then it must be `none`, which requires Secure. |

`server/src/preflight.js` checks these at startup. A setting that would leave a
protection off, or that no browser can work with, refuses to start. A missing
feature dependency warns loudly and lets the rest of the app run.

## Migrations are a deploy STEP, not a container start-up command

```bash
npm run db:migrate     # once, before rolling out the new image
```

The Dockerfile deliberately does not run them. Running migrations on container
start means every replica races the same DDL on every deploy, and it puts a
schema change inside the same command as a restart — so a bad migration takes
the service down instead of failing a deploy step.

## Building and running

```bash
docker build -t fm-platform:latest .
docker run -p 4000:4000 --env-file .env.production fm-platform:latest
```

One image serves both the API and the built React app on one port. That is the
reason the session cookie can be `SameSite=Lax` and `CORS_ORIGINS` can stay
empty: same origin, so neither problem exists.

`/health` is liveness — it never touches the database, so a database outage does
not make an orchestrator kill a healthy process and restart it into the same
outage. `/ready` is readiness — it *does* check the database and returns 503
when it cannot, so a load balancer routes around the instance instead.

## Known, accepted risks

**`xlsx` (SheetJS) 0.18.5 — HIGH severity, no fix available on npm.**
Prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9). The
patched 0.20.x releases are published only to the vendor's own CDN, not to npm.

*Mitigation in place:* every spreadsheet and PDF is parsed inside a worker
thread with a 30-second timeout (`server/src/services/documentWorker.js`).
Pollution lands in an isolate that is destroyed when the parse ends, and a
regex sent exponential burns one worker rather than freezing the server. This
contains the advisories; it does not fix them.

*To actually fix it,* from a network that can reach the vendor:

```bash
npm install --workspace=server https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

Then re-run `npm test` — the spreadsheet tests are the check that the upgrade
did not change how a real RFQ is read.

**Offer templates — resolved.** `server/templates/offers/pressure_gauge.docx`
is now in the repository. It is your own `Format.docx` with `{{placeholder}}`
tags where the values go: letterhead, covering letter, product-family table and
commercial terms copied untouched, and the specification and price tables taken
from `Technocommercial offer.docx` and emptied of that example's values. It was
generated by `build_template.py` rather than hand-edited, so it can be rebuilt
against a revised `Format.docx`. See `server/templates/offers/README.md`.

Two things to check before this goes to a customer:

1. **Read a generated offer end to end.** `npm test` proves no tag is left
   unrendered and that the words "undefined" and "null" never appear, but only
   a person can confirm the wording and the commercial terms are current.
2. **The template is a single line item.** `POST /offers/generate` takes one
   `productId`, and the tags are numbered accordingly (`model1`, `range1`).
   An offer covering several different products needs a docxtemplater loop in
   the template and a matching change in `renderOffer()` — not `model2`,
   `model3`.

## What is NOT covered

* **Backups.** Nothing in this repo backs the database up. `db/exportCatalogue.js`
  snapshots the *catalogue* to JSON; it does not touch enquiries, offers or
  users. Configure backups at the database provider (Neon has point-in-time
  restore) before real enquiries are in there.
* **Secret rotation.** There is no key-rotation story because there are no
  application-level secrets yet — sessions are random tokens in a table. If
  that changes, this section needs to as well.
* **Log aggregation.** Logs go to stdout. Fine for one container; if you run
  several, ship them somewhere before you need to read them.
