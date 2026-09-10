// server/src/middleware/rateLimit.js
//
// Three limiters, because one global number cannot be right for endpoints
// whose costs differ by three orders of magnitude:
//
//   apiLimiter    — everything. A blunt ceiling so no single client can
//                   saturate the process.
//   loginLimiter  — POST /auth/login only. Each attempt costs ~100 ms of CPU
//                   in scrypt by design, so this is both an anti-guessing and
//                   an anti-DoS control.
//   heavyLimiter  — file uploads and enquiry matching. A single 25 MB PDF can
//                   occupy the event loop for seconds in pdf-parse, and a
//                   10-line RFQ fans out to ~31 LLM calls.
//
// The counters are in-process. With one server that is exactly right. If the
// deployment ever runs more than one instance, these become per-instance and
// the effective limit multiplies by the instance count — at that point swap in
// the Redis store rather than raising the numbers. Recorded here so the
// weakening is noticed rather than discovered.

const rateLimit = require('express-rate-limit');

// Tests and local development would otherwise trip the limiter while
// exercising the very endpoints they are testing. Guarded so it can only ever
// be switched off outside production.
const DISABLED = process.env.NODE_ENV !== 'production' && process.env.DISABLE_RATE_LIMIT === 'true';

function build(options) {
  if (DISABLED) return (req, res, next) => next();
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // The default handler returns plain text; the rest of this API answers
    // JSON, and the frontend parses JSON.
    handler: (req, res) => res.status(429).json({ error: options.message }),
    ...options,
  });
}

const apiLimiter = build({
  windowMs: 60 * 1000,
  limit: 300,                 // 5 req/s sustained per IP — far above a human, far below a scraper
  message: 'Too many requests. Please slow down and try again shortly.',
});

const loginLimiter = build({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  // Only failures count. Someone legitimately signing in on several devices
  // should not be pushed towards the limit by their successes.
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts from this address. Try again in a few minutes.',
});

const heavyLimiter = build({
  windowMs: 60 * 1000,
  limit: 30,
  message: 'Too many uploads or matching requests. Please wait a moment.',
});

module.exports = { apiLimiter, loginLimiter, heavyLimiter };
