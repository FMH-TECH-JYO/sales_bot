// server/test/errorHandler.test.js
//
// Two properties of the error handler, both learned the hard way.
//
// 1. A 500 must not carry the underlying message. It used to return
//    `err.message` for every status, which hands a client raw Postgres text —
//    column names, table names, sometimes parameter values.
//
// 2. "The database is unreachable" must not look like "this code threw".
//    Signing in against a stopped Postgres produced *"Something went wrong on
//    our side. Quote reference 1aa13945bdc5"* — true, unhelpful, and
//    indistinguishable from a bug in the login logic. Time went into reading
//    the login controller when the answer was that nothing was listening on
//    the database port.
//
// The REAL errorHandler is imported and mounted here, not re-implemented. An
// earlier version of this file tried to inject probe routes into the running
// app's middleware stack; that fought the SPA fallback and tested nothing
// useful. Exporting the handler and mounting it on a bare app exercises the
// actual function with none of that interference.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { errorHandler, isDatabaseUnreachable } = require('../src/app');

let server;
let baseUrl;

before(async () => {
  const probe = express();

  probe.get('/boom', (req, res, next) => {
    const err = new Error('relation "secret_table" does not exist');
    err.code = '42P01';
    next(err);
  });

  probe.get('/db-down/:code', (req, res, next) => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    err.code = req.params.code;
    next(err);
  });

  probe.get('/db-down-nested', (req, res, next) => {
    const err = new Error('pool error');
    err.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    next(err);
  });

  probe.get('/client-error', (req, res, next) => {
    const err = new Error('Password must be at least 12 characters.');
    err.status = 400;
    err.code = 'WEAK_PASSWORD';
    next(err);
  });

  probe.use(errorHandler);

  await new Promise((resolve) => { server = probe.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body };
}

describe('isDatabaseUnreachable', () => {
  test('recognises the socket errors that mean "nothing answered"', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']) {
      assert.equal(isDatabaseUnreachable({ code }), true, code);
    }
  });

  test('recognises the Postgres codes that mean "not available right now"', () => {
    // 57P01 admin shutdown, 57P02 crash shutdown, 57P03 still starting or in
    // recovery, 53300 too many connections.
    for (const code of ['57P01', '57P02', '57P03', '53300']) {
      assert.equal(isDatabaseUnreachable({ code }), true, code);
    }
  });

  test('does NOT treat misconfiguration as transient', () => {
    // 28P01 wrong password, 3D000 no such database. Neither fixes itself, so
    // calling them transient would have a load balancer retry forever instead
    // of failing loudly where someone would notice.
    for (const code of ['28P01', '3D000', '42P01', '22P02']) {
      assert.equal(isDatabaseUnreachable({ code }), false, code);
    }
  });

  test('looks one level into a wrapped error, as pg-pool produces', () => {
    assert.equal(isDatabaseUnreachable({ cause: { code: 'ECONNREFUSED' } }), true);
  });

  test('null and undefined are safe', () => {
    assert.equal(isDatabaseUnreachable(null), false);
    assert.equal(isDatabaseUnreachable(undefined), false);
    assert.equal(isDatabaseUnreachable({}), false);
  });
});

describe('error handler', () => {
  test('a 500 does not leak the underlying message', async () => {
    const res = await get('/boom');
    assert.equal(res.status, 500);
    assert.equal(res.text.includes('secret_table'), false, 'the table name reached the client');
    assert.equal(res.text.includes('42P01'), false);
    assert.match(res.body.error, /Something went wrong/);
  });

  test('a 500 carries a reference that ties the response to the log line', async () => {
    // Without it, "it broke" from a user cannot be matched to anything in the
    // log and the operator is searching by timestamp.
    const res = await get('/boom');
    assert.match(res.body.ref, /^[0-9a-f]{12}$/);
    assert.ok(res.body.error.includes(res.body.ref));
  });

  test('two failures get different references', async () => {
    const a = await get('/boom');
    const b = await get('/boom');
    assert.notEqual(a.body.ref, b.body.ref);
  });

  test('an unreachable database is a 503, and says so', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P03', '53300']) {
      const res = await get(`/db-down/${code}`);
      assert.equal(res.status, 503, `${code} should be 503, got ${res.status}`);
      assert.equal(res.body.code, 'DATABASE_UNAVAILABLE');
      // The message must point at the thing to check. "Something went wrong"
      // sends someone into the wrong source file.
      assert.match(res.body.error, /database/i);
      assert.match(res.body.error, /DATABASE_URL/);
    }
  });

  test('a socket error wrapped by the pool is still recognised', async () => {
    const res = await get('/db-down-nested');
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'DATABASE_UNAVAILABLE');
  });

  test('the 503 message leaks no host, port or credential', async () => {
    const res = await get('/db-down/ECONNREFUSED');
    assert.equal(res.text.includes('127.0.0.1'), false);
    assert.equal(res.text.includes('5432'), false);
  });

  test('bad credentials and a missing database stay 500, not 503', async () => {
    for (const code of ['28P01', '3D000']) {
      const res = await get(`/db-down/${code}`);
      assert.equal(res.status, 500, `${code} should stay 500`);
    }
  });

  test('a 4xx keeps its message, because the user needs it', async () => {
    const res = await get('/client-error');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Password must be at least 12 characters.');
    assert.equal(res.body.code, 'WEAK_PASSWORD');
  });
});
