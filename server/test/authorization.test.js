// server/test/authorization.test.js
//
// The route/role matrix, asserted exhaustively.
//
// This file is the regression test for the P0 finding: before migration 007,
// `POST /catalogue-uploads/1/publish` with no credentials at all returned
// HTTP 200, and GET /enquiries handed every customer name, quantity and price
// in the system to anyone who could reach the port.
//
// Every route is listed here with the roles that may reach it. A new route
// that is not in this table shows up as a failure in the last test, which is
// the point: the way a guard gets forgotten is by nobody noticing a new route
// was added.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startServer, stopServer, createTestUser, cleanupTestData, call, signIn, db } = require('./helpers');

// Each entry: [method, path, who may reach it]
// 'anon' means no credentials. A route that anon may reach must be one whose
// response contains nothing about customers, prices or the catalogue.
const MATRIX = [
  ['GET',   '/health',                        ['anon', 'engineer', 'admin']],
  ['GET',   '/ready',                         ['anon', 'engineer', 'admin']],

  ['GET',   '/products',                      ['engineer', 'admin']],
  // A product id is a model CODE, not a number — see validateParams.js.
  ['GET',   '/products/FMLG-BM',              ['engineer', 'admin']],
  ['GET',   '/products/FMLG-BM/catalogue',    ['engineer', 'admin']],

  ['GET',   '/categories',                    ['engineer', 'admin']],
  ['POST',  '/categories',                    ['admin']],

  ['GET',   '/enquiries',                     ['engineer', 'admin']],
  ['GET',   '/enquiries/1',                   ['engineer', 'admin']],
  ['POST',  '/enquiries/match',               ['engineer', 'admin']],

  ['GET',   '/offers',                        ['engineer', 'admin']],
  ['GET',   '/offers/fields/FMLG-BM',         ['engineer', 'admin']],
  ['POST',  '/offers/generate',               ['engineer', 'admin']],

  ['GET',   '/catalogue-uploads',             ['admin']],
  ['GET',   '/catalogue-uploads/status-counts', ['admin']],
  ['GET',   '/catalogue-uploads/1',           ['admin']],
  ['GET',   '/catalogue-uploads/1/file',      ['admin']],
  ['POST',  '/catalogue-uploads',             ['admin']],
  ['PATCH', '/catalogue-uploads/1',           ['admin']],
  ['POST',  '/catalogue-uploads/1/publish',   ['admin']],
  ['POST',  '/catalogue-uploads/1/reject',    ['admin']],
  ['POST',  '/catalogue-uploads/1/reopen',    ['admin']],
  ['POST',  '/catalogue-uploads/1/retry-draft', ['admin']],

  ['GET',   '/auth/users',                    ['admin']],
  ['POST',  '/auth/users',                    ['admin']],
  ['PATCH', '/auth/users/1',                  ['admin']],
  ['GET',   '/auth/me',                       ['engineer', 'admin']],
  // Public by necessity: you cannot present a credential in order to obtain one.
  ['POST',  '/auth/login',                    ['anon', 'engineer', 'admin']],
  // Public on purpose: an already-expired token must still be able to clear
  // the browser's cookie, rather than 401 and leave a dead session in place.
  ['POST',  '/auth/logout',                   ['anon', 'engineer', 'admin']],
  ['POST',  '/auth/password',                 ['engineer', 'admin']],
];

// Two routes END the session they are called with: logout revokes it, and a
// password change revokes every session for that user. Calling them with the
// shared tokens below would leave every later test unauthenticated — a defect
// in the test, not in the application — so they get a disposable session each.
const SESSION_DESTROYING = new Set(['/auth/logout', '/auth/password']);

describe('authorization matrix', () => {
  const tokens = {};
  const users = {};
  let adminUser;

  before(async () => {
    await startServer();
    users.engineer = await createTestUser({ role: 'sales_engineer' });
    users.admin = adminUser = await createTestUser({ role: 'admin' });
    tokens.engineer = (await signIn(users.engineer)).token;
    tokens.admin = (await signIn(users.admin)).token;
    tokens.anon = undefined;
  });

  /** A token for `who` that the caller may safely destroy. */
  async function disposableToken(who) {
    if (who === 'anon') return undefined;
    const throwaway = await createTestUser({ role: who === 'admin' ? 'admin' : 'sales_engineer' });
    return (await signIn(throwaway)).token;
  }

  after(async () => {
    await cleanupTestData();
    await stopServer();
    await db.pool.end();
  });

  for (const [method, path, allowed] of MATRIX) {
    for (const who of ['anon', 'engineer', 'admin']) {
      const permitted = allowed.includes(who);
      test(`${who} ${permitted ? 'MAY' : 'may NOT'} ${method} ${path}`, async () => {
        const token = SESSION_DESTROYING.has(path) ? await disposableToken(who) : tokens[who];
        const res = await call(path, { method, token, body: method === 'GET' ? undefined : {} });

        if (!permitted) {
          // 401 when there is no credential, 403 when there is one but the
          // role is wrong. The `code` is asserted too: a 401 that happens to
          // come from somewhere else — a controller's own check, say — would
          // pass a bare status assertion while proving nothing about the guard.
          const expected = who === 'anon'
            ? { status: 401, code: 'UNAUTHENTICATED' }
            : { status: 403, code: 'FORBIDDEN' };
          assert.equal(res.status, expected.status,
            `expected ${expected.status}, got ${res.status}: ${res.text.slice(0, 200)}`);
          assert.equal(res.body?.code, expected.code,
            `${res.status} did not come from the auth guard: ${res.text.slice(0, 200)}`);
          return;
        }

        // Permitted: the guards must not be what turns the request away. It may
        // legitimately fail for other reasons — a missing row is 404, an empty
        // body is 400, a wrong current password is a 401 raised by the
        // controller — and asserting a 200 here would make this a test of the
        // controllers rather than of the guards. So the check is specifically
        // "not rejected BY THE GUARD", identified by its code.
        assert.notEqual(res.body?.code, 'UNAUTHENTICATED',
          `${who} was refused by the auth guard: ${res.text.slice(0, 200)}`);
        assert.notEqual(res.body?.code, 'FORBIDDEN',
          `${who} was refused by the role guard: ${res.text.slice(0, 200)}`);
      });
    }
  }

  test('an admin cannot strip their own admin role', async () => {
    // Otherwise a mis-click can leave an installation with no administrator
    // and no way to make one without shell access to the database.
    const res = await call(`/auth/users/${adminUser.id}`, {
      method: 'PATCH', token: tokens.admin, body: { role: 'sales_engineer' },
    });
    assert.equal(res.status, 400);
    const { rows } = await db.query('SELECT role FROM users WHERE id = $1', [adminUser.id]);
    assert.equal(rows[0].role, 'admin');
  });

  test('an admin cannot deactivate their own account', async () => {
    const res = await call(`/auth/users/${adminUser.id}`, {
      method: 'PATCH', token: tokens.admin, body: { active: false },
    });
    assert.equal(res.status, 400);
  });

  test('an engineer cannot promote themselves', async () => {
    const engineer2 = await createTestUser({ role: 'sales_engineer' });
    const { token } = await signIn(engineer2);
    const res = await call(`/auth/users/${engineer2.id}`, {
      method: 'PATCH', token, body: { role: 'admin' },
    });
    assert.equal(res.status, 403);
    const { rows } = await db.query('SELECT role FROM users WHERE id = $1', [engineer2.id]);
    assert.equal(rows[0].role, 'sales_engineer');
  });

  test('a new user cannot be created with an unknown role', async () => {
    const res = await call('/auth/users', {
      method: 'POST', token: tokens.admin,
      body: { name: 'X', email: 'x@example.invalid', role: 'superuser', password: 'a-long-enough-password' },
    });
    assert.equal(res.status, 400);
  });

  test('every registered route appears in the matrix above', async () => {
    // The way a guard gets forgotten is that a route is added and nobody
    // notices. This walks Express's own router and fails on anything unlisted,
    // so adding a route forces a deliberate decision about who may call it.
    const listed = new Set(MATRIX.map(([m, p]) =>
      `${m} ${p.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/FMLG-BM(?=\/|$)/g, '/:id')}`));

    const registered = new Set();
    const walk = (stack, prefix = '') => {
      for (const layer of stack) {
        if (layer.route) {
          const p = prefix + layer.route.path;
          for (const m of Object.keys(layer.route.methods)) {
            if (m === '_all') continue;
            // '/products' + '/' is the same route as '/products'; normalise
            // the trailing slash so the matrix reads the way a URL is written.
            const normalised = p.replace(/:[A-Za-z_]+/g, ':id').replace(/(.)\/$/, '$1');
            registered.add(`${m.toUpperCase()} ${normalised}`);
          }
        } else if (layer.name === 'router' && layer.handle?.stack) {
          // Recover the mount path from the layer's own regexp — Express does
          // not keep it anywhere friendlier.
          const src = layer.regexp?.source || '';
          const m = /^\^\\\/([^\\?]+)/.exec(src);
          walk(layer.handle.stack, prefix + (m ? `/${m[1]}` : ''));
        }
      }
    };
    const { app } = require('../src/app');
    walk(app._router.stack);

    // The SPA fallback and static file handlers are not API routes.
    const apiRoutes = [...registered].filter((r) => !r.includes('(?!'));

    const missing = apiRoutes.filter((r) => !listed.has(r));
    assert.deepEqual(missing, [],
      `these routes are not in the authorization matrix — decide who may call them and add them:\n  ${missing.join('\n  ')}`);
  });
});
