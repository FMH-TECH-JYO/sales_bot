// server/src/preflight.js
//
// Checks run once at startup for the things that are configured OUTSIDE the
// code and are therefore easy to get wrong on a new machine or a new
// deployment — and whose absence otherwise shows up hours later as a confusing
// user-facing failure.
//
// Two rules:
//
//   * A missing SECRET or a wide-open setting in production is FATAL. Starting
//     anyway means running the thing the setting was supposed to prevent.
//   * A missing FEATURE dependency is a loud warning, not a crash. If the
//     offer templates are absent, matching and history still work and the team
//     can still use the app; refusing to start would take away the working 90%
//     to punish the missing 10%.
//
// Every message says what is wrong AND what to do about it. "Configuration
// error" tells nobody anything.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/**
 * @param {object}  [opts]
 * @param {object}  [opts.env]         defaults to process.env
 * @param {object}  [opts.log]         defaults to console
 * @param {boolean} [opts.hasWebDist]  overrides the filesystem check. Exists so
 *   the tests can assert both branches deterministically: whether web/dist is
 *   present depends on whether someone has run a build, which is exactly the
 *   kind of ambient state that makes a test pass on one machine and fail on
 *   the next.
 */
function checkProductionPrerequisites({ env = process.env, log = console, hasWebDist } = {}) {
  const webDistPresent = hasWebDist !== undefined
    ? hasWebDist
    : fs.existsSync(path.join(REPO_ROOT, 'web', 'dist'));
  const fatal = [];
  const warnings = [];
  const isProduction = env.NODE_ENV === 'production';

  // --- offer templates -------------------------------------------------------
  // generateOffer.js resolves templates here and hasTemplate() returns false
  // when the directory has no .docx in it, so EVERY offer request answers
  // "No offer template uploaded yet for category X". That is the last step of
  // the enquiry-to-offer flow, silently unavailable.
  const templatesDir = path.join(REPO_ROOT, 'server', 'templates', 'offers');
  let templates = [];
  try {
    templates = fs.readdirSync(templatesDir).filter((f) => f.toLowerCase().endsWith('.docx'));
  } catch {
    templates = [];
  }
  if (templates.length === 0) {
    warnings.push(
      'No offer templates found in server/templates/offers/.\n' +
      '    Offer generation will answer "No offer template uploaded yet" for every product.\n' +
      '    Fix: add pressure_gauge.docx (the company-wide fallback) to that directory.\n' +
      '    See server/templates/offers/README.md.'
    );
  }

  // --- CORS ------------------------------------------------------------------
  // An empty allowlist in production is CORRECT when Express serves web/dist
  // from the same origin, and wrong when the frontend is deployed separately —
  // in which case every browser call fails and it looks like the API is down.
  if (isProduction && !env.CORS_ORIGINS && !webDistPresent) {
    fatal.push(
      'NODE_ENV=production with no CORS_ORIGINS and no web/dist to serve.\n' +
      '    Nothing can call this API from a browser: same-origin is impossible because the\n' +
      '    frontend is not being served from here, and cross-origin is refused because the\n' +
      '    allowlist is empty.\n' +
      '    Fix: either build the frontend (npm run build) or set CORS_ORIGINS to the site\n' +
      '    that serves it, e.g. CORS_ORIGINS=https://sales.forbesmarshall.example'
    );
  }

  // --- cookies behind TLS ----------------------------------------------------
  if (isProduction && env.COOKIE_SAMESITE === 'none' && env.COOKIE_SECURE === 'false') {
    fatal.push(
      'COOKIE_SAMESITE=none requires a Secure cookie; COOKIE_SECURE=false disables it.\n' +
      '    Browsers reject that combination outright, so nobody would be able to sign in.\n' +
      '    Fix: remove COOKIE_SECURE=false (production sets Secure automatically).'
    );
  }

  // --- rate limiting ---------------------------------------------------------
  // rateLimit.js already refuses to honour this flag in production; this says
  // so out loud, so nobody spends an afternoon wondering why it had no effect.
  if (isProduction && env.DISABLE_RATE_LIMIT === 'true') {
    warnings.push(
      'DISABLE_RATE_LIMIT=true is set but is IGNORED in production — the limiters are active.\n' +
      '    Remove it from the production environment to avoid confusion.'
    );
  }

  // --- proxy awareness -------------------------------------------------------
  if (isProduction && !env.TRUST_PROXY) {
    warnings.push(
      'TRUST_PROXY is not set. If this process sits behind nginx or a platform router,\n' +
      '    req.ip is the proxy\'s address, so the rate limiter treats every user as one client\n' +
      '    and the sessions table records the wrong IP.\n' +
      '    Fix: set TRUST_PROXY=1 when there IS a proxy. Leave it EMPTY when there is not —\n' +
      '    trusting X-Forwarded-For with nothing in front lets a client spoof its own address.'
    );
  }

  // --- storage ---------------------------------------------------------------
  // The whole "database is empty every time I pull from git" saga was per-machine
  // state. STORAGE_DRIVER=local in production reintroduces exactly that: the
  // datasheets live on one container's disk and vanish when it is replaced.
  if (isProduction && (env.STORAGE_DRIVER || 'local') === 'local') {
    warnings.push(
      'STORAGE_DRIVER=local in production. Datasheets are written to this instance\'s disk,\n' +
      '    so they are lost when the container is replaced and invisible to any other replica.\n' +
      '    Fix: run `npm run db:import-uploads` once, then set STORAGE_DRIVER=db.'
    );
  }

  for (const w of warnings) log.warn(`[preflight] WARNING: ${w}`);
  for (const f of fatal) log.error(`[preflight] FATAL: ${f}`);

  return { fatal, warnings, ok: fatal.length === 0 };
}

module.exports = { checkProductionPrerequisites };
