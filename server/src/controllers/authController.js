// server/src/controllers/authController.js
//
// POST /auth/login, POST /auth/logout, GET /auth/me, POST /auth/password
// plus admin-only user management under /auth/users.

const db = require('../config/db');
const { verifyPassword, hashPassword } = require('../services/password');
const { createSession, revokeSession, revokeAllForUser } = require('../services/sessions');
const { COOKIE_NAME, readCredential } = require('../middleware/auth');

// Wrong password lockout. 10 tries, then 15 minutes. Generous enough that a
// person who genuinely forgot which of their two passwords it was is not
// locked out, tight enough that online guessing is pointless. The IP-based
// rate limiter in index.js handles the distributed-username case; this one
// protects a single account from being hammered from many IPs.
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

function cookieOptions(expiresAt) {
  const secure = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
  return {
    httpOnly: true,          // page JavaScript, including any XSS payload, cannot read it
    secure,                  // HTTPS only in production
    // 'lax' keeps the cookie on top-level navigations (so a bookmarked /admin
    // link still works) while withholding it from cross-site POSTs. When the
    // API and the app are on different origins — the dev setup, Vite on :5173
    // and Express on :4000 — the browser requires 'none' + Secure instead.
    sameSite: process.env.COOKIE_SAMESITE || (secure ? 'lax' : 'lax'),
    expires: expiresAt,
    path: '/',
  };
}

/** Never send password_hash, failed_logins or locked_until to a client. */
function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: row.active };
}

// POST /auth/login  { email, password }
async function login(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const { rows } = await db.query(
    `SELECT id, name, email, role, active, password_hash, failed_logins, locked_until
       FROM users WHERE LOWER(email) = $1`,
    [email]
  );
  const user = rows[0];

  // One message and one status code for every failure mode below — unknown
  // email, no password set, deactivated account, wrong password. Distinct
  // messages would let anyone enumerate who works here.
  const reject = () => res.status(401).json({ error: 'Invalid email or password.' });

  if (!user) {
    // Spend roughly the time a real verification would, so response latency
    // does not reveal whether the address exists.
    await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
    return reject();
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(429).json({
      error: 'Too many failed sign-in attempts. Try again in a few minutes.',
    });
  }

  const ok = user.active && (await verifyPassword(password, user.password_hash));

  if (!ok) {
    const failed = (user.failed_logins || 0) + 1;
    const lockUntil = failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null;
    await db.query(
      'UPDATE users SET failed_logins = $1, locked_until = COALESCE($2, locked_until) WHERE id = $3',
      [failed, lockUntil, user.id]
    );
    return reject();
  }

  await db.query(
    'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
    [user.id]
  );

  const { token, expiresAt } = await createSession({
    userId: user.id,
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });

  res.cookie(COOKIE_NAME, token, cookieOptions(expiresAt));

  // The token is echoed in the body for non-browser clients (scripts, the
  // test suite). The browser app ignores it and relies on the HttpOnly
  // cookie — storing it in localStorage would undo the point of HttpOnly.
  res.json({ user: publicUser(user), token, expiresAt });
}

// POST /auth/logout
async function logout(req, res) {
  const cred = readCredential(req);
  if (cred) await revokeSession(cred.token);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}

// GET /auth/me — the frontend calls this on load to find out whether the
// cookie it already holds is still good, and what role it grants. The role
// shown in the UI comes from here, from the server, never from localStorage.
async function me(req, res) {
  res.json({ user: publicUser(req.user) });
}

// POST /auth/password  { currentPassword, newPassword } — change your own.
async function changePassword(req, res) {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');

  const { rows } = await db.query('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id]);
  const row = rows[0];
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const hash = await hashPassword(newPassword);   // throws 400 if too short
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

  // Every other session belonging to this user dies. If the reason for the
  // change is "I think someone has my password", leaving their sessions alive
  // would make the change pointless.
  await revokeAllForUser(req.user.id);
  const { token, expiresAt } = await createSession({
    userId: req.user.id, userAgent: req.get('user-agent'), ip: req.ip,
  });
  res.cookie(COOKIE_NAME, token, cookieOptions(expiresAt));
  res.json({ ok: true, token, expiresAt });
}

// GET /auth/users — admin only
async function listUsers(req, res) {
  const { rows } = await db.query(
    `SELECT id, name, email, role, active, created_at, last_login_at,
            (password_hash IS NOT NULL) AS has_password
       FROM users ORDER BY name`
  );
  res.json(rows);
}

const ROLES = new Set(['sales_engineer', 'manager', 'admin']);

// POST /auth/users  { name, email, role, password } — admin only
async function createUser(req, res) {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = String(req.body?.role || 'sales_engineer');
  const password = String(req.body?.password || '');

  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (!ROLES.has(role)) return res.status(400).json({ error: `Role must be one of: ${[...ROLES].join(', ')}.` });

  const hash = await hashPassword(password);      // throws 400 if too short

  try {
    const { rows } = await db.query(
      `INSERT INTO users (name, email, role, active, password_hash)
       VALUES ($1, $2, $3, TRUE, $4)
       RETURNING id, name, email, role, active`,
      [name, email, role, hash]
    );
    res.status(201).json(publicUser(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' });
    throw err;
  }
}

// PATCH /auth/users/:id  { role?, active?, password? } — admin only
async function updateUser(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id.' });

  const sets = [];
  const params = [];

  if (req.body?.role !== undefined) {
    if (!ROLES.has(req.body.role)) return res.status(400).json({ error: 'Invalid role.' });
    // An admin must not be able to demote themselves and leave the system with
    // no administrator; and self-demotion mid-session is confusing besides.
    if (id === req.user.id && req.body.role !== req.user.role) {
      return res.status(400).json({ error: 'You cannot change your own role.' });
    }
    params.push(req.body.role);
    sets.push(`role = $${params.length}`);
  }

  if (req.body?.active !== undefined) {
    if (id === req.user.id && req.body.active === false) {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
    params.push(Boolean(req.body.active));
    sets.push(`active = $${params.length}`);
  }

  if (req.body?.password !== undefined) {
    params.push(await hashPassword(String(req.body.password)));
    sets.push(`password_hash = $${params.length}`);
    sets.push('failed_logins = 0', 'locked_until = NULL');
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  params.push(id);
  const { rows } = await db.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, name, email, role, active`,
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found.' });

  // Deactivating someone, or resetting their password, has to end their live
  // sessions — otherwise the change does not take effect until they happen to
  // log out, which is exactly the case where it matters least.
  if (req.body?.active === false || req.body?.password !== undefined) {
    await revokeAllForUser(id);
  }

  res.json(publicUser(rows[0]));
}

module.exports = { login, logout, me, changePassword, listUsers, createUser, updateUser };
