// server/src/app.js
//
// The Express application, with no side effects: it does not listen on a port
// and does not install process-level handlers. index.js does that.
//
// Split out of index.js so the test suite can mount the real application —
// the same middleware chain, the same routes, the same guards — without
// starting a long-lived server or having to guess a free port. A test that
// exercises a copy of the app is a test of the copy.

require('../../config/env');

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const db = require('./config/db');
const { apiLimiter } = require('./middleware/rateLimit');

const app = express();

// --- query parsing -----------------------------------------------------------
// Express's default "extended" query parser is the `qs` library. express@4.22.2
// — the latest 4.x — pins qs 6.15.3, which carries two moderate advisories: an
// array-limit bypass via bracket-key comma parsing (GHSA-x5fp-wj9c-mxmx) and a
// denial of service via a caller-controlled isBuffer (GHSA-4mjr-xmp4-gh2g).
// No express release resolves it, and a root `overrides` entry upgrades
// body-parser's copy of qs but not the one express requires directly.
//
// 'simple' switches to Node's built-in querystring module, removing the
// vulnerable code path rather than merely reducing the chance of reaching it.
// The cost: req.query no longer parses nested objects or arrays, so `?a[b]=1`
// arrives as the literal key "a[b]". Every query parameter this API reads is a
// scalar — limit, offset, category, status; `grep -rn req.query server/src` —
// so nothing is given up. If a future endpoint genuinely needs structured
// query input, parse it explicitly rather than turning this back on.
app.set('query parser', 'simple');

// Behind a reverse proxy (nginx, a platform router) req.ip is the proxy's
// address unless this is set, which would make the rate limiter treat every
// user as one client. Opt-in via env, because trusting X-Forwarded-For when
// there is NO proxy in front lets a client spoof its own IP and escape the
// limiter entirely.
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v);
}

// --- security headers --------------------------------------------------------
// helmet sets X-Content-Type-Options, Referrer-Policy, X-Frame-Options and
// friends. The CSP below governs the built React app served from this same
// origin.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Vite emits a small inline module script in index.html, and the app's
      // styles are injected as inline <style> at runtime.
      scriptSrc: ["'self'"],

      // Google Fonts is allowed for STYLESHEETS and FONT FILES only.
      //
      // web/src/index.css opens with an @import of Roboto — the Forbes
      // Marshall brand toolbox names Roboto as the web font and says Arial is
      // print-only. A CSP of just 'self' blocked it, so the deployed app
      // silently fell back to a system font and the browser console filled
      // with "Refused to load the stylesheet". Nothing failed loudly; the
      // application simply stopped being on-brand.
      //
      // Two hosts, because Google serves them separately: googleapis.com
      // returns the CSS, gstatic.com serves the .woff2 files it references.
      // Allowing only the first still blocks the font itself.
      //
      // If this ever has to run on a network without access to Google, swap
      // the @import for self-hosted @font-face files and delete both entries —
      // see the note at the top of index.css.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],

      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", ...(process.env.CSP_CONNECT_SRC || '').split(',').filter(Boolean)],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // The app serves generated .docx and .pdf downloads; COEP breaks nothing
  // here but crossOriginResourcePolicy: 'same-site' would block the Vite dev
  // server on :5173 fetching from :4000.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// --- CORS --------------------------------------------------------------------
// Was `cors()` with no arguments, i.e. Access-Control-Allow-Origin: * on a
// write-capable API. With credentials now in play that is not merely sloppy,
// it is forbidden by the spec (a wildcard origin cannot be combined with
// credentials) — so the allowlist below is load-bearing, not decorative.
//
// CORS_ORIGINS is a comma-separated list. In production it must be set; an
// empty list there means "same origin only", which is correct when Express is
// also serving web/dist.
const configuredOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const devOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const allowedOrigins = new Set(
  process.env.NODE_ENV === 'production' ? configuredOrigins : [...configuredOrigins, ...devOrigins]
);

app.use(cors({
  origin(origin, callback) {
    // No Origin header: same-origin navigation, curl, a server-to-server call.
    // Those are not subject to the browser's cross-origin rules at all.
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    // Deny by not setting the header, rather than by throwing: an error here
    // becomes a 500, which misreports a policy decision as a server fault.
    return callback(null, false);
  },
  credentials: true,                     // the session cookie has to cross in dev
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Disposition'],
}));

app.use(cookieParser());

// A JSON body limit. `express.json()` defaults to 100 kb, which sounds safe
// until you notice this app never had one set explicitly and the default is
// easy to raise by accident later. Stated here so the number is a decision.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '256kb' }));

app.use(apiLimiter);

// --- health ------------------------------------------------------------------
// Liveness: the process is up and answering. Never touches the database, so a
// database outage does not make an orchestrator kill an otherwise healthy
// process it would only restart into the same outage.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'fm-platform-server', uptime_s: Math.round(process.uptime()) });
});

// Readiness: should this instance receive traffic? This one does check the
// database, and returns 503 when it cannot, so a load balancer routes around
// an instance whose pool is exhausted or whose credentials are wrong.
app.get('/ready', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS product_count FROM products');
    res.json({ status: 'ready', product_count: rows[0].product_count });
  } catch (err) {
    console.error('Readiness check failed:', err.message);
    res.status(503).json({ status: 'not_ready' });
  }
});

// --- API ---------------------------------------------------------------------
app.use('/auth', require('./routes/auth'));
app.use('/products', require('./routes/products'));
app.use('/categories', require('./routes/categories'));
app.use('/catalogue-uploads', require('./routes/catalogueUploads'));
app.use('/enquiries', require('./routes/enquiries'));
app.use('/offers', require('./routes/offers'));

// --- built frontend ----------------------------------------------------------
const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
const API_PREFIXES = ['auth', 'products', 'categories', 'catalogue-uploads', 'enquiries', 'offers', 'health', 'ready'];

if (fs.existsSync(webDist)) {
  // index.html must not be cached, or a deploy leaves browsers loading the old
  // HTML (and therefore the old, now-deleted, hashed asset filenames). The
  // hashed assets themselves are safe to cache forever.
  app.use(express.static(webDist, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      else if (/\.[0-9a-f]{8,}\.(js|css|woff2?|png|svg)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // SPA fallback: any non-API GET that isn't a static file goes to index.html
  // so React Router's client-side routes (/chat, /matching, …) survive a refresh.
  const spaFallback = new RegExp(`^(?!\\/(${API_PREFIXES.join('|')})(\\/|$)).*`);
  app.get(spaFallback, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  // Friendly root — otherwise hitting the server in a browser shows Express's
  // bare "Cannot GET /", which looks like a crash even when the server is fine.
  app.get('/', (req, res) => {
    res.json({
      service: 'fm-platform-server',
      status: 'running',
      note: 'web/dist not built — run `npm run build --workspace=web` to serve the UI from here.',
      try: ['/health', '/ready', '/auth/login', '/products', '/categories'],
    });
  });
}

// --- 404 for unmatched API routes -------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

/**
 * Is this error "I could not reach the database", as opposed to a bug?
 *
 * Matched on error CODES rather than message text: pg and libpq set these, and
 * they do not change with locale or version the way a message string does.
 *
 *   ECONNREFUSED  nothing listening — Postgres stopped, or the wrong port
 *   ENOTFOUND     the host does not resolve — a typo, or DNS is down
 *   ETIMEDOUT     no answer — firewall, or a serverless database still waking
 *   ECONNRESET    the connection was dropped mid-query
 *   EHOSTUNREACH / ENETUNREACH  no route to the host
 *   57P01/57P02/57P03  Postgres itself: admin shutdown, crash shutdown,
 *                      cannot connect now (still starting up or in recovery)
 *   53300         too many connections — the pool is exhausted, which is a
 *                 capacity problem to route around, not a code defect
 *
 * Deliberately NOT included: 28P01 (bad password) and 3D000 (no such database).
 * Those are misconfiguration that will never fix itself, so reporting them as a
 * transient 503 would have a load balancer retry forever instead of failing
 * loudly. They stay 500s and land in the log with their reference id.
 */
const DB_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  '57P01', '57P02', '57P03', '53300',
]);

function isDatabaseUnreachable(err) {
  if (!err) return false;
  if (DB_UNREACHABLE_CODES.has(err.code)) return true;
  // pg-pool wraps the socket error, so check one level down too.
  return Boolean(err.cause && DB_UNREACHABLE_CODES.has(err.cause.code));
}

// --- error handler -----------------------------------------------------------
// MUST be registered last. Every async route is wrapped in asyncHandler, so a
// thrown or rejected error lands here rather than crashing the process.
//
// What changed: this used to return `err.message` for every status, which
// hands a client the raw Postgres error text ("column p.foo does not exist",
// table names, sometimes parameter values) on any 500. Client errors — the 4xx
// this code raises deliberately, marked expose or given a status — still carry
// their message, because "Password must be at least 12 characters" is useless
// to an attacker and essential to a user. Anything 500 and above becomes a
// fixed string plus an id that ties the response to the log line.
function errorHandler(err, req, res, next) {    
  let status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;

  // "The database is unreachable" is not the same fault as "this code threw",
  // and reporting both as an opaque 500 wasted real time: signing in against a
  // stopped Postgres produced "Something went wrong on our side, quote
  // reference 1aa13945bdc5" — true, unhelpful, and indistinguishable from a
  // bug in the login logic. 503 is the correct code for a dependency being
  // unavailable, it tells a load balancer to route elsewhere, and the message
  // points at the thing to actually check.
  //
  // The specific message is safe to show: that a service has a database is not
  // a secret, and no host, port, credential or query text is included.
  if (isDatabaseUnreachable(err)) status = 503;

  if (status >= 500) {
    const ref = require('crypto').randomBytes(6).toString('hex');
    console.error(`[${ref}] ${req.method} ${req.originalUrl}`, err);
    return res.status(status).json({
      error: status === 503
        ? 'The service cannot reach its database right now. If this persists, check that the database is running and that DATABASE_URL is correct. Reference ' + ref + '.'
        : 'Something went wrong on our side. Quote reference ' + ref + ' if you report this.',
      code: status === 503 ? 'DATABASE_UNAVAILABLE' : undefined,
      ref,
    });
  }

  // 4xx: log at a lower volume, return the message the code chose. `code` is
  // forwarded when the thrower set one — clients need to distinguish "your
  // session ended" (UNAUTHENTICATED, from the auth guard) from a 401 a
  // controller raised for its own reasons, e.g. a wrong current password.
  console.warn(`${status} ${req.method} ${req.originalUrl}: ${err.message}`);
  const payload = { error: err.message || 'Request could not be processed' };
  if (typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)) payload.code = err.code;
  res.status(status).json(payload);
}

app.use(errorHandler);

module.exports = { app, allowedOrigins, errorHandler, isDatabaseUnreachable };
