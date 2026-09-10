// server/src/services/sessions.js
//
// Server-side session store. See db/migrations/007_auth.sql for why sessions
// and not JWTs.
//
// The raw token is 32 bytes from crypto.randomBytes, base64url-encoded. Only
// its SHA-256 is written to the database, so a database dump does not contain
// anything that can be replayed as a login. SHA-256 (rather than scrypt) is
// correct here precisely because the token is already 256 bits of uniform
// randomness: there is no low-entropy secret to slow an attacker down over,
// and lookups happen on every single request.

const crypto = require('crypto');
const db = require('../config/db');

const TOKEN_BYTES = 32;
// Eight hours: one working day. Long enough that a sales engineer is not
// re-authenticating between enquiries, short enough that a session left open
// on a shared machine has expired by the next morning.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
// last_seen_at is only written when it is this stale, so a busy user does not
// generate one UPDATE per HTTP request.
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * @param {object} args
 * @param {number} args.userId
 * @param {string} [args.userAgent]
 * @param {string} [args.ip]
 * @returns {Promise<{token: string, expiresAt: Date}>} raw token — returned to the
 *   caller exactly once and never recoverable afterwards
 */
async function createSession({ userId, userAgent = null, ip = null }) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), userId, expiresAt, (userAgent || '').slice(0, 512) || null, ip]
  );
  return { token, expiresAt };
}

/**
 * Resolve a raw token to the live user behind it.
 *
 * A single query joins sessions to users so that deactivating a user
 * (users.active = false) takes effect on their NEXT request rather than at
 * their next login — which is what "revoke access now" has to mean.
 *
 * @param {string} rawToken
 * @returns {Promise<{id, name, email, role, sessionId}|null>}
 */
async function resolveSession(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 16 || rawToken.length > 256) return null;

  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.last_seen_at,
            u.id, u.name, u.email, u.role, u.active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > CURRENT_TIMESTAMP`,
    [hashToken(rawToken)]
  );
  const row = rows[0];
  if (!row || !row.active) return null;

  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS) {
    // Fire-and-forget: a failed bookkeeping UPDATE must not fail the request
    // the user actually made.
    db.query('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = $1', [row.session_id])
      .catch((err) => console.error('Could not touch session:', err.message));
  }

  return { id: row.id, name: row.name, email: row.email, role: row.role, sessionId: row.session_id };
}

/** Log out one session. Idempotent: revoking an unknown token is not an error. */
async function revokeSession(rawToken) {
  if (typeof rawToken !== 'string' || !rawToken) return 0;
  const { rowCount } = await db.query(
    'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(rawToken)]
  );
  return rowCount;
}

/** Log a user out everywhere — used when their password changes or their
 * account is deactivated. A password reset that leaves old sessions alive is
 * not a password reset. */
async function revokeAllForUser(userId) {
  const { rowCount } = await db.query(
    'UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
  return rowCount;
}

/** Delete sessions that expired more than 30 days ago. Called on a timer from
 * index.js; rows are kept for a while after expiry because "when did this
 * person last sign in, and from where" is an audit question. */
async function purgeExpiredSessions() {
  const { rowCount } = await db.query(
    "DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL '30 days'"
  );
  return rowCount;
}

module.exports = {
  createSession, resolveSession, revokeSession, revokeAllForUser, purgeExpiredSessions,
  SESSION_TTL_MS, hashToken,
};
