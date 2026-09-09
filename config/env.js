// config/env.js
//
// THE single place this repo loads environment configuration. Nothing else
// should call require('dotenv').config() — importing this module is how you
// get env, from anywhere, regardless of what the current working directory
// happens to be.
//
// Why this file exists at all:
//
//   Before it, eight different files each called dotenv themselves, and they
//   disagreed about where .env lives — some used the process CWD
//   (`dotenv.config()`, which only finds .env if you happen to run the
//   command from the repo root), some used a hand-counted relative path
//   ('../.env', '../../../.env'). Any script run from the "wrong" folder
//   silently got NO configuration: process.env.DATABASE_URL came back
//   undefined, `new Pool({ connectionString: undefined })` fell through to
//   pg's defaults, and the only symptom the user ever saw was
//
//       SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
//
//   which says nothing about the actual problem ("there is no .env").
//   That error is now impossible: see assertDatabaseUrl() below.
//
// It also fixes the fresh-clone case. `.env` is gitignored (correctly — it
// can hold real credentials), so `git clone` NEVER produces one. Every new
// machine therefore started life broken in exactly the way above. This
// module creates .env from .env.example the first time it's missing, so a
// clone + `npm install` + `npm run setup` works with no manual steps.

const fs = require('fs');
const path = require('path');

/** Absolute path of the repo root, resolved from THIS file — never from CWD. */
const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');

let bootstrapped = false;

function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;

  if (!fs.existsSync(ENV_PATH)) {
    if (fs.existsSync(ENV_EXAMPLE_PATH)) {
      fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
      // .env can hold real credentials, and copyFileSync inherits the
      // example's mode (often read-only from a git checkout). Make it
      // owner-read/write so it is editable and not world-readable.
      try { fs.chmodSync(ENV_PATH, 0o600); } catch { /* best effort (Windows) */ }
      console.warn(
        '\n[env] No .env found — created one from .env.example.\n' +
        `      ${ENV_PATH}\n` +
        '      It points at the local Postgres from docker-compose.yml\n' +
        '      (postgres://fm:fm_dev_password@localhost:5432/fm_platform).\n' +
        '      Edit it if your database is somewhere else.\n'
      );
    } else {
      console.warn(`[env] No .env and no .env.example at ${REPO_ROOT} — using process environment only.`);
    }
  }

  require('dotenv').config({ path: ENV_PATH });
}

bootstrap();

/**
 * Fail loudly and usefully instead of letting pg throw the SASL error.
 * Every entry point (server + every db/*.js script) calls this before it
 * opens a connection.
 */
function assertDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (typeof url === 'string' && url.trim()) return url.trim();

  console.error(
    '\n================================================================\n' +
    ' DATABASE_URL is not set — the app cannot connect to Postgres.\n' +
    '================================================================\n' +
    `  Expected it in: ${ENV_PATH}\n\n` +
    '  Fix (Windows PowerShell / cmd / bash all fine):\n' +
    '    1. Make sure Postgres is running:  docker compose up -d\n' +
    '    2. Copy the example env file:      copy .env.example .env\n' +
    '    3. Re-run what you just ran.\n\n' +
    '  If .env exists but this still fires, the file has no DATABASE_URL\n' +
    '  line, or it was saved as UTF-16/with a BOM (save it as UTF-8).\n'
  );
  const err = new Error('DATABASE_URL is not configured');
  err.code = 'ENV_MISSING_DATABASE_URL';
  throw err;
}

/**
 * Where uploaded datasheet PDFs live, as ONE absolute path derived from the
 * repo root.
 *
 * The old code did `path.resolve(server/src/storage/../../', LOCAL_UPLOAD_DIR)`
 * with LOCAL_UPLOAD_DIR='./server/uploads' from .env.example, which resolves
 * to <repo>/server/server/uploads — while the PDFs committed to git live in
 * <repo>/server/uploads. That is why this repo currently has BOTH folders and
 * why a machine with a .env stored files somewhere a machine without one
 * could not find them. Resolving against REPO_ROOT makes './server/uploads'
 * mean what it says, on every machine, with or without .env.
 */
function uploadDir() {
  const configured = process.env.LOCAL_UPLOAD_DIR || './server/uploads';
  return path.resolve(REPO_ROOT, configured);
}

module.exports = { REPO_ROOT, ENV_PATH, ENV_EXAMPLE_PATH, assertDatabaseUrl, uploadDir };
