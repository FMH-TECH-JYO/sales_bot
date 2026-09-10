// server/test/auth.test.js
//
// End-to-end authentication behaviour against the real app and a real database.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, stopServer, createTestUser, cleanupTestData, call, signIn, db,
} = require('./helpers');

describe('authentication', () => {
  let engineer;
  let admin;

  before(async () => {
    await startServer();
    engineer = await createTestUser({ role: 'sales_engineer' });
    admin = await createTestUser({ role: 'admin' });
  });

  after(async () => {
    await cleanupTestData();
    await stopServer();
    await db.pool.end();
  });

  // --- signing in ------------------------------------------------------------

  test('correct credentials return the user, a token and a cookie', async () => {
    const res = await call('/auth/login', {
      method: 'POST',
      body: { email: engineer.email, password: engineer.password },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, engineer.email);
    assert.equal(res.body.user.role, 'sales_engineer');
    assert.ok(res.body.token, 'a token should be issued');

    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, /fm_session=/);
    // HttpOnly is the control that keeps an XSS payload from stealing the
    // session, so it is worth asserting rather than assuming.
    assert.match(setCookie, /HttpOnly/i);
  });

  test('the response never contains the password hash', async () => {
    const res = await call('/auth/login', {
      method: 'POST',
      body: { email: engineer.email, password: engineer.password },
    });
    assert.equal(res.text.includes('scrypt$'), false);
    assert.equal('password_hash' in res.body.user, false);
    assert.equal('failed_logins' in res.body.user, false);
  });

  test('a wrong password is rejected', async () => {
    const res = await call('/auth/login', {
      method: 'POST',
      body: { email: engineer.email, password: 'definitely-not-it' },
    });
    assert.equal(res.status, 401);
  });

  test('an unknown address gets the SAME message as a wrong password', async () => {
    // Different messages would turn this endpoint into a way of finding out
    // who works here.
    const unknown = await call('/auth/login', {
      method: 'POST',
      body: { email: 'nobody-at-all@example.invalid', password: 'definitely-not-it' },
    });
    const wrongPassword = await call('/auth/login', {
      method: 'POST',
      body: { email: engineer.email, password: 'definitely-not-it' },
    });
    assert.equal(unknown.status, wrongPassword.status);
    assert.equal(unknown.body.error, wrongPassword.body.error);
  });

  test('email is matched case-insensitively', async () => {
    const res = await call('/auth/login', {
      method: 'POST',
      body: { email: engineer.email.toUpperCase(), password: engineer.password },
    });
    assert.equal(res.status, 200);
  });

  test('a missing password is a 400, not a 500', async () => {
    const res = await call('/auth/login', { method: 'POST', body: { email: engineer.email } });
    assert.equal(res.status, 400);
  });

  test('a deactivated account cannot sign in', async () => {
    const dormant = await createTestUser({ role: 'sales_engineer', active: false });
    const res = await call('/auth/login', {
      method: 'POST',
      body: { email: dormant.email, password: dormant.password },
    });
    assert.equal(res.status, 401);
  });

  test('an account with no password set cannot sign in', async () => {
    // Every users row that predates migration 007 is in this state. It must be
    // "cannot sign in", not "signs in with anything".
    const { rows } = await db.query(
      `INSERT INTO users (name, email, role, active, password_hash)
       VALUES ('Legacy', $1, 'admin', TRUE, NULL) RETURNING email`,
      [`test+${require('./helpers').RUN_ID}-legacy@example.invalid`]
    );
    for (const attempt of ['', 'anything', 'null', 'undefined']) {
      const res = await call('/auth/login', {
        method: 'POST', body: { email: rows[0].email, password: attempt },
      });
      assert.equal(res.status === 200, false, `logged in with "${attempt}"`);
    }
  });

  // --- using a session -------------------------------------------------------

  test('/auth/me works with a bearer token', async () => {
    const { token } = await signIn(engineer);
    const res = await call('/auth/me', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, engineer.email);
  });

  test('/auth/me works with the cookie', async () => {
    const { cookie } = await signIn(engineer);
    const res = await call('/auth/me', { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.email, engineer.email);
  });

  test('/auth/me with no credential is 401', async () => {
    assert.equal((await call('/auth/me')).status, 401);
  });

  test('a forged or truncated token is rejected', async () => {
    const { token } = await signIn(engineer);
    for (const bad of [
      'not-a-token-at-all-but-long-enough',
      token.slice(0, -1),                 // one character short
      token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),  // one character changed
      '',
    ]) {
      assert.equal((await call('/auth/me', { token: bad })).status, 401, `accepted: ${bad}`);
    }
  });

  test('the raw token is never stored — only its hash', async () => {
    const { token } = await signIn(engineer);
    const { rows } = await db.query('SELECT token_hash FROM sessions WHERE token_hash = $1', [token]);
    assert.equal(rows.length, 0, 'the raw token was found in the sessions table');

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows: byHash } = await db.query('SELECT id FROM sessions WHERE token_hash = $1', [hash]);
    assert.equal(byHash.length, 1);
  });

  // --- ending a session ------------------------------------------------------

  test('logout revokes the session immediately', async () => {
    const { token } = await signIn(engineer);
    assert.equal((await call('/auth/me', { token })).status, 200);

    assert.equal((await call('/auth/logout', { method: 'POST', token })).status, 200);
    assert.equal((await call('/auth/me', { token })).status, 401, 'the token still worked after logout');
  });

  test('an expired session is refused', async () => {
    const { token } = await signIn(engineer);
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await db.query(
      "UPDATE sessions SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE token_hash = $1",
      [hash]
    );
    assert.equal((await call('/auth/me', { token })).status, 401);
  });

  test('deactivating a user kills their live session on the next request', async () => {
    // Not at their next login — that is the case where it matters least.
    const victim = await createTestUser({ role: 'sales_engineer' });
    const { token } = await signIn(victim);
    assert.equal((await call('/auth/me', { token })).status, 200);

    await db.query('UPDATE users SET active = FALSE WHERE id = $1', [victim.id]);
    assert.equal((await call('/auth/me', { token })).status, 401);
  });

  test('changing a password signs every other session out', async () => {
    const user = await createTestUser({ role: 'sales_engineer' });
    const phone = await signIn(user);
    const laptop = await signIn(user);

    const res = await call('/auth/password', {
      method: 'POST',
      token: laptop.token,
      body: { currentPassword: user.password, newPassword: 'a-brand-new-password' },
    });
    assert.equal(res.status, 200);

    // The old session on the other device is dead…
    assert.equal((await call('/auth/me', { token: phone.token })).status, 401);
    // …and so is the one that made the change; it was handed a fresh token.
    assert.equal((await call('/auth/me', { token: laptop.token })).status, 401);
    assert.equal((await call('/auth/me', { token: res.body.token })).status, 200);

    // The new password works and the old one does not.
    assert.equal((await call('/auth/login', {
      method: 'POST', body: { email: user.email, password: 'a-brand-new-password' },
    })).status, 200);
    assert.equal((await call('/auth/login', {
      method: 'POST', body: { email: user.email, password: user.password },
    })).status, 401);
  });

  test('a password change with the wrong current password is refused', async () => {
    const { token } = await signIn(engineer);
    const res = await call('/auth/password', {
      method: 'POST', token,
      body: { currentPassword: 'not-the-current-one', newPassword: 'some-new-password' },
    });
    assert.equal(res.status, 401);
  });

  test('a password change to something too short is refused with a 400', async () => {
    const user = await createTestUser({ role: 'sales_engineer' });
    const { token } = await signIn(user);
    const res = await call('/auth/password', {
      method: 'POST', token,
      body: { currentPassword: user.password, newPassword: 'short' },
    });
    assert.equal(res.status, 400);
    // And the old password must still work — a rejected change must change nothing.
    assert.equal((await call('/auth/login', {
      method: 'POST', body: { email: user.email, password: user.password },
    })).status, 200);
  });

  // --- account lockout -------------------------------------------------------

  test('repeated wrong passwords lock the account, and the lock is not a bypass', async () => {
    const target = await createTestUser({ role: 'sales_engineer' });
    let locked = false;
    for (let i = 0; i < 12; i++) {
      const res = await call('/auth/login', {
        method: 'POST', body: { email: target.email, password: `wrong-guess-${i}` },
      });
      if (res.status === 429) { locked = true; break; }
    }
    assert.equal(locked, true, 'the account never locked after 12 wrong guesses');

    // Critically: while locked, the CORRECT password must not sign in either.
    // A lockout that the real password walks through is not a lockout.
    const res = await call('/auth/login', {
      method: 'POST', body: { email: target.email, password: target.password },
    });
    assert.equal(res.status, 429);
  });

  test('a successful sign-in clears the failure counter', async () => {
    const user = await createTestUser({ role: 'sales_engineer' });
    for (let i = 0; i < 3; i++) {
      await call('/auth/login', { method: 'POST', body: { email: user.email, password: 'nope' } });
    }
    assert.equal((await call('/auth/login', {
      method: 'POST', body: { email: user.email, password: user.password },
    })).status, 200);

    const { rows } = await db.query('SELECT failed_logins FROM users WHERE id = $1', [user.id]);
    assert.equal(rows[0].failed_logins, 0);
  });

  // --- CSRF ------------------------------------------------------------------

  test('a cookie-authenticated write without X-Requested-With is refused', async () => {
    // This is the CSRF control: a cross-site form post or <img> cannot set a
    // custom header, so requiring one on every cookie-authenticated write
    // means a request that arrives without it did not come from our app.
    const { cookie } = await signIn(admin);
    const res = await call('/categories', {
      method: 'POST', cookie, body: { id: 'csrf-probe', label: 'CSRF probe' },
    });
    assert.equal(res.status, 403);
  });

  test('the same write succeeds with the header', async () => {
    const { cookie } = await signIn(admin);
    const res = await call('/categories', {
      method: 'POST', cookie,
      headers: { 'X-Requested-With': 'fetch' },
      body: { id: `test-cat-${Date.now()}`, label: 'Test category' },
    });
    assert.ok(res.status === 200 || res.status === 201, `unexpected ${res.status}: ${res.text}`);
    await db.query('DELETE FROM categories WHERE id LIKE $1', ['test-cat-%']);
  });

  test('cookie-authenticated READS do not need the header', async () => {
    // Requiring it on GETs would break every <a href> download and every
    // bookmarked link without adding protection: a cross-site GET cannot read
    // the response anyway.
    const { cookie } = await signIn(engineer);
    assert.equal((await call('/products', { cookie })).status, 200);
  });

  test('a bearer-authenticated write does NOT need the header', async () => {
    // A bearer token is not ambient credentials — a hostile page has no way to
    // obtain one — so the CSRF control does not apply to it.
    const { token } = await signIn(admin);
    const res = await call('/categories', {
      method: 'POST', token, body: { id: `test-cat-b-${Date.now()}`, label: 'Bearer category' },
    });
    assert.ok(res.status === 200 || res.status === 201, `unexpected ${res.status}: ${res.text}`);
    await db.query('DELETE FROM categories WHERE id LIKE $1', ['test-cat-b-%']);
  });
});
