// server/test/preflight.test.js
//
// The startup checks are only useful if they fire on the misconfigurations
// that actually happen and stay quiet on the ones that do not. A preflight
// that cries wolf gets commented out.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { checkProductionPrerequisites } = require('../src/preflight');

const silent = { warn() {}, error() {} };
// hasWebDist is passed explicitly rather than left to the filesystem: whether
// web/dist exists depends on whether someone has run a build, and a test that
// depends on that passes on one machine and fails on the next.
const run = (env, hasWebDist = true) => checkProductionPrerequisites({ env, log: silent, hasWebDist });

describe('checkProductionPrerequisites', () => {
  test('development with nothing set is fine', () => {
    // Someone who has just cloned the repo must not be met with a wall of
    // warnings about production concerns that do not apply to them.
    const r = run({ NODE_ENV: 'development' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.fatal, []);
  });

  test('a cookie configuration browsers reject outright is FATAL', () => {
    // SameSite=None without Secure is refused by every current browser, so
    // nobody could sign in. Starting and letting people discover that one at a
    // time is worse than failing the deploy.
    const r = run({ NODE_ENV: 'production', COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false', CORS_ORIGINS: 'https://x.example' });
    assert.equal(r.ok, false);
    assert.match(r.fatal.join(' '), /Secure/);
  });

  test('production with no CORS allowlist AND no frontend to serve is FATAL', () => {
    // Nothing can reach the API from a browser: same-origin is impossible
    // because the frontend is elsewhere, cross-origin is refused because the
    // allowlist is empty. It presents as "the API is down".
    const r = run({ NODE_ENV: 'production' }, false);
    assert.equal(r.ok, false);
    assert.match(r.fatal.join(' '), /CORS_ORIGINS/);
  });

  test('production with an explicit allowlist is not fatal', () => {
    const r = run({ NODE_ENV: 'production', CORS_ORIGINS: 'https://sales.example' }, false);
    assert.equal(r.ok, true);
  });

  test('production serving its own web/dist needs no allowlist', () => {
    // Same-origin: there is no cross-origin call to permit, so an empty
    // CORS_ORIGINS is the correct configuration rather than an omission.
    const r = run({ NODE_ENV: 'production' }, true);
    assert.equal(r.ok, true);
  });

  test('local file storage in production warns but does not stop the app', () => {
    // This is the per-machine-state failure the project already spent a day
    // on, in a new form: datasheets on one container's disk, gone when it is
    // replaced. Worth shouting about; not worth refusing to serve over.
    const r = run({ NODE_ENV: 'production', CORS_ORIGINS: 'https://x.example', STORAGE_DRIVER: 'local' });
    assert.equal(r.ok, true);
    assert.match(r.warnings.join(' '), /STORAGE_DRIVER/);
  });

  test('database-backed storage in production does not warn about storage', () => {
    const r = run({ NODE_ENV: 'production', CORS_ORIGINS: 'https://x.example', STORAGE_DRIVER: 'db' });
    assert.equal(r.warnings.some((w) => /STORAGE_DRIVER/.test(w)), false);
  });

  test('DISABLE_RATE_LIMIT in production is reported as ignored', () => {
    // rateLimit.js refuses to honour it there. Saying so saves an afternoon of
    // wondering why the flag had no effect.
    const r = run({ NODE_ENV: 'production', CORS_ORIGINS: 'https://x.example', DISABLE_RATE_LIMIT: 'true' });
    assert.match(r.warnings.join(' '), /IGNORED in production/);
  });

  test('every message says what to do, not just what is wrong', () => {
    const r = run({ NODE_ENV: 'production' }, false);
    for (const m of [...r.fatal, ...r.warnings]) {
      assert.match(m, /Fix:|See /, `no remedy offered:\n${m}`);
    }
  });

  test('the missing offer templates are reported as a warning against this repo as it stands', () => {
    // server/templates/offers/ contains only a README — no .docx — so offer
    // generation answers "No offer template uploaded yet" for every product.
    // This asserts the check SEES that, which is the point of having it.
    const r = run({ NODE_ENV: 'development' });
    assert.match(r.warnings.join(' '), /offer template/i);
    assert.equal(r.ok, true, 'a missing template must not stop the app');
  });
});
