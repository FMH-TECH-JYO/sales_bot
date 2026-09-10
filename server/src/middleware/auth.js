// server/src/middleware/auth.js
//
// requireAuth / requireRole — the two guards every non-public route uses.
//
// Two credential carriers are accepted, deliberately:
//
//   1. The `fm_session` cookie. HttpOnly, so page JavaScript (and therefore an
//      XSS payload) cannot read it. This is what the browser app uses.
//   2. `Authorization: Bearer <token>`. This is what scripts, the test suite
//      and any future service-to-service caller use. It is NOT ambient — a
//      caller has to go out of its way to attach it.
//
// CSRF, and why the X-Requested-With check below is not cargo cult:
// a cookie is sent by the browser on cross-site requests too, so without
// something extra, evil.example could POST to /catalogue-uploads/1/publish
// from a logged-in engineer's browser and it would succeed. Three things
// together close that:
//   * SameSite on the cookie (set in authController) stops the common case;
//   * the CORS allowlist in index.js means no unapproved origin gets a
//     successful preflight;
//   * and this middleware requires the custom header X-Requested-With on every
//     state-changing, cookie-authenticated request. A cross-origin form post
//     or <img> cannot set a custom header at all, and an XHR/fetch that tries
//     is forced into a preflight that the allowlist rejects.
// Bearer-authenticated requests skip the header check because a Bearer token
// is not ambient credentials — an attacker's page has no way to obtain one.

const { resolveSession } = require('../services/sessions');

const COOKIE_NAME = 'fm_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The `code` on these is load-bearing, not decoration. A 401 from THIS
// middleware means "your session is gone, sign in again"; a 401 from a
// controller can mean something entirely different — /auth/password answers
// 401 for a wrong *current* password while the session is perfectly valid.
// Without a way to tell them apart, a client that logs the user out on any 401
// would eject them from the app for mistyping their old password. So the guard
// stamps UNAUTHENTICATED / FORBIDDEN, and only those mean "the session ended".
function unauthorized(message = 'Authentication required') {
  const err = new Error(message);
  err.status = 401;
  err.code = 'UNAUTHENTICATED';
  err.expose = true;
  return err;
}

function forbidden(message = 'You do not have permission to do that') {
  const err = new Error(message);
  err.status = 403;
  err.code = 'FORBIDDEN';
  err.expose = true;
  return err;
}

/**
 * Reads the credential without validating it. Returns
 * { token, via: 'cookie'|'bearer' } or null.
 */
function readCredential(req) {
  const header = req.get('authorization') || '';
  const bearer = /^Bearer\s+(\S+)$/i.exec(header);
  if (bearer) return { token: bearer[1], via: 'bearer' };

  const cookieToken = req.cookies && req.cookies[COOKIE_NAME];
  if (cookieToken) return { token: cookieToken, via: 'cookie' };

  return null;
}

/**
 * Populates req.user when a valid credential is present; otherwise leaves it
 * undefined and continues. For routes that behave differently for signed-in
 * users but do not require one. Never rejects.
 */
async function attachUser(req, res, next) {
  try {
    const cred = readCredential(req);
    if (cred) {
      const user = await resolveSession(cred.token);
      if (user) {
        req.user = user;
        req.authVia = cred.via;
      }
    }
  } catch (err) {
    // A database blip must not be silently treated as "not logged in" for a
    // route that only *optionally* wants a user; log it and carry on unauthenticated.
    console.error('attachUser failed:', err.message);
  }
  next();
}

/** Hard gate: 401 unless a valid session is presented. */
function requireAuth(req, res, next) {
  const cred = readCredential(req);
  if (!cred) return next(unauthorized());

  resolveSession(cred.token)
    .then((user) => {
      if (!user) return next(unauthorized('Your session has expired. Please sign in again.'));

      if (cred.via === 'cookie' && !SAFE_METHODS.has(req.method) && !req.get('x-requested-with')) {
        return next(forbidden('Missing X-Requested-With header on a state-changing request.'));
      }

      req.user = user;
      req.authVia = cred.via;
      next();
    })
    .catch(next);
}

/**
 * Role gate. Use AFTER requireAuth:
 *     router.post('/:id/publish', requireAuth, requireRole('admin'), handler)
 *
 * Roles are the ones in the users.role column: 'sales_engineer' | 'manager' |
 * 'admin'. No hierarchy is implied — list every role that may perform the
 * action. Implicit hierarchies ("admin can do anything a manager can") are
 * where privilege-escalation bugs hide.
 *
 * @param {...string} allowed
 */
function requireRole(...allowed) {
  const allowedSet = new Set(allowed.flat());
  return function roleGate(req, res, next) {
    if (!req.user) return next(unauthorized());
    if (!allowedSet.has(req.user.role)) {
      return next(forbidden(`This action requires one of: ${[...allowedSet].join(', ')}.`));
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, attachUser, COOKIE_NAME, readCredential };
