-- 007_auth.sql
--
-- Real server-side authentication.
--
-- Until this migration the application had NONE. "Admin login" was a button
-- that wrote the string 'admin' into localStorage under the key fm_role; the
-- server never looked at it. A request with no cookie, no token and no header
-- could publish a catalogue (POST /catalogue-uploads/:id/publish returned 200)
-- and could read every enquiry and every offer, i.e. every customer name,
-- quantity and price the system holds. Everything below exists to close that.
--
-- Design decisions worth recording:
--
--  * Opaque random session tokens, not JWTs. A JWT cannot be revoked before it
--    expires without a server-side deny list, at which point it has the same
--    storage cost as a session row and none of the simplicity. 20-30 people on
--    one Postgres instance do not need stateless auth; they need the ability to
--    log someone out immediately when they leave the company.
--
--  * Only the SHA-256 of the token is stored. A database dump (or a read-only
--    reporting query) must not hand out live sessions. The raw token exists
--    only in the client's cookie.
--
--  * password_hash is nullable. Existing rows in users were seeded without one
--    and must not be silently granted a login; a NULL hash means "this account
--    cannot sign in yet" and is rejected by the verifier before any comparison
--    happens. Set one with `node db/createUser.js`.
--
--  * No default account and no default password are created here. A well-known
--    admin/admin on every deployment would recreate the hole this migration is
--    closing.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at  TIMESTAMP;

-- Failed-login throttling lives on the row rather than in memory so it
-- survives a restart and is shared across every server process behind a load
-- balancer. An attacker who can restart the process must not get a fresh
-- allowance of guesses.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until   TIMESTAMP;

-- Email is compared case-insensitively everywhere; enforce that in the index
-- so 'Admin@fm.com' and 'admin@fm.com' cannot both exist as separate logins.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS sessions (
  id           SERIAL PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,      -- sha256(raw token); the raw token is never stored
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at   TIMESTAMP,                 -- set on logout; row kept for audit
  user_agent   TEXT,
  ip           TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
