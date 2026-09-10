// server/test/helpers.js
//
// Shared setup for the integration tests.
//
// These tests exercise the REAL application object from server/src/app.js —
// the same middleware chain, the same routes, the same guards — over a real
// HTTP socket, against a real Postgres. Nothing is mocked. A test that runs
// against a hand-built copy of the app is a test of the copy, and an auth test
// with a mocked auth layer proves nothing at all.
//
// They therefore need a database. If DATABASE_URL is unset or unreachable the
// suite FAILS with an explanatory message rather than skipping: a green run
// that quietly tested nothing is worse than a red one.
//
// Test data is namespaced by a per-run random suffix and removed in after(),
// so running these against a development database does not disturb it.

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// The rate limiters exist to stop abuse; inside a test they would only stop
// the test. This flag is honoured by rateLimit.js ONLY when NODE_ENV is not
// production, so it cannot weaken a real deployment.
process.env.DISABLE_RATE_LIMIT = 'true';

require('../../config/env');

const crypto = require('crypto');
const assert = require('node:assert/strict');

const { app } = require('../src/app');
const db = require('../src/config/db');
const { hashPassword } = require('../src/services/password');

const RUN_ID = crypto.randomBytes(4).toString('hex');

let server;
let baseUrl;

/** Start the app on an OS-assigned free port. Port 0 avoids the "is 4000 in
 * use" coin-flip that makes suites flaky on a developer machine that happens
 * to have the dev server running. */
async function startServer() {
  if (server) return baseUrl;
  await assertDatabaseReachable();
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve).on('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

async function stopServer() {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
}

async function assertDatabaseReachable() {
  try {
    await db.query('SELECT 1');
  } catch (err) {
    throw new Error(
      'These tests need a running database.\n' +
      `  DATABASE_URL is ${process.env.DATABASE_URL ? 'set but unreachable' : 'not set'}.\n` +
      `  Underlying error: ${err.message}\n` +
      '  Fix: start Postgres (docker compose up -d) and run `npm run setup`.'
    );
  }
  const { rows } = await db.query(
    "SELECT to_regclass('public.sessions') IS NOT NULL AS ok"
  );
  if (!rows[0].ok) {
    throw new Error('The sessions table is missing — run `npm run db:migrate` before testing.');
  }
}

/** Create a user that exists only for this test run. */
async function createTestUser({ role = 'sales_engineer', password = 'test-password-1234', active = true } = {}) {
  const email = `test+${RUN_ID}-${crypto.randomBytes(3).toString('hex')}@example.invalid`;
  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, active, password_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role`,
    [`Test ${role}`, email, role, active, await hashPassword(password)]
  );
  return { ...rows[0], password };
}

/** Remove everything this run created. Ordered so foreign keys are satisfied
 * without relying on ON DELETE CASCADE being present on every path. */
async function cleanupTestData() {
  await db.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`test+${RUN_ID}-%`]
  );
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`test+${RUN_ID}-%`]);
}

/**
 * Minimal HTTP client.
 * @param {string} path
 * @param {object} [opts]
 * @param {string} [opts.token]  sent as Authorization: Bearer
 * @param {string} [opts.cookie] sent as a Cookie header
 * @returns {Promise<{status:number, body:any, headers:Headers, text:string}>}
 */
async function call(path, { method = 'GET', token, cookie, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  if (body !== undefined && !(body instanceof FormData)) {
    h['Content-Type'] = h['Content-Type'] || 'application/json';
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
    redirect: 'manual',
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON — body stays null, text is there */ }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

/** Sign in and return { token, cookie, user }. */
async function signIn(user) {
  const res = await call('/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  assert.equal(res.status, 200, `login failed for ${user.email}: ${res.text}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  return { token: res.body.token, cookie, user: res.body.user };
}

module.exports = {
  startServer, stopServer, createTestUser, cleanupTestData, call, signIn, db, RUN_ID,
};
