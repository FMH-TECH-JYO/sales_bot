// server/test/validateParams.test.js
//
// numericParam exists because GET /enquiries/notanumber reached Postgres as
// `WHERE id = 'notanumber'`, raised 22P02 invalid_input_syntax, and surfaced as
// a 500 — a client mistake reported as a server fault, and (before the error
// handler was fixed) with the raw Postgres text attached.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { numericParam, productCode } = require('../src/middleware/validateParams');

/** Run a validator against a fake request and report what it did. */
function exercise(validator, params, names) {
  const req = { params: { ...params } };
  let error = null;
  let called = false;
  validator(...names)(req, {}, (err) => { called = true; error = err || null; });
  return { called, error, params: req.params };
}

const run = (params, names = ['id']) => exercise(numericParam, params, names);
const runCode = (params, names = ['id']) => exercise(productCode, params, names);

describe('numericParam', () => {
  test('lets a plain integer through', () => {
    const r = run({ id: '42' });
    assert.equal(r.error, null);
    assert.equal(r.params.id, '42');
  });

  test('rejects a non-numeric id with 400, not 500', () => {
    const r = run({ id: 'notanumber' });
    assert.equal(r.error.status, 400);
  });

  test('rejects a partly-numeric id rather than silently truncating it', () => {
    // parseInt('12abc') is 12. Accepting that would turn a malformed URL into
    // a confident lookup of the wrong record.
    for (const bad of ['12abc', '1.5', '1e3', ' 12', '12 ', '+12', '0x1f']) {
      assert.equal(run({ id: bad }).error?.status, 400, `accepted: ${JSON.stringify(bad)}`);
    }
  });

  test('rejects zero and negatives', () => {
    assert.equal(run({ id: '0' }).error?.status, 400);
    assert.equal(run({ id: '-1' }).error?.status, 400);
  });

  test('rejects an id past the range of a Postgres INTEGER', () => {
    // 2147483648 raises 22003 numeric_value_out_of_range — another spurious 500.
    assert.equal(run({ id: '2147483648' }).error?.status, 400);
    assert.equal(run({ id: '99999999999999999999' }).error?.status, 400);
    assert.equal(run({ id: '2147483647' }).error, null);
  });

  test('rejects SQL-shaped input at the edge', () => {
    // Every query in this app is parameterised, so this is not what stops
    // injection — but a request like this is malformed and should be turned
    // away before it reaches a controller at all.
    for (const bad of ["1 OR 1=1", '1; DROP TABLE users', "1'--"]) {
      assert.equal(run({ id: bad }).error?.status, 400, `accepted: ${bad}`);
    }
  });

  test('an absent parameter is not an error', () => {
    // The middleware validates what is there; it does not invent requirements.
    const r = run({}, ['id']);
    assert.equal(r.error, null);
  });

  test('checks every name it is given', () => {
    assert.equal(run({ id: '1', productId: 'oops' }, ['id', 'productId']).error?.status, 400);
    assert.equal(run({ id: '1', productId: '7' }, ['id', 'productId']).error, null);
  });

  test('always calls next exactly once', () => {
    // A middleware that forgets to call next() hangs the request until the
    // client times out, which looks like a dead server.
    assert.equal(run({ id: '42' }).called, true);
    assert.equal(run({ id: 'bad' }).called, true);
    assert.equal(run({}).called, true);
  });
});

describe('productCode', () => {
  // products.id is TEXT — the model code. A numeric validator was briefly
  // applied to /products/:id and rejected every real product with a 400.
  // These are the ids that are actually in the seeded catalogue.
  test('accepts the model codes this catalogue really contains', () => {
    for (const code of ['FMLG-BM', 'FMDPT-6000', 'FMDPT-7000', 'FD', 'FMPT-012', 'FMLG-MG']) {
      assert.equal(runCode({ id: code }).error, null, `rejected real product code ${code}`);
    }
  });

  test('accepts codes with a dot, slash, underscore or space', () => {
    for (const code of ['FM.100', 'FM/200', 'FM_300', 'FM 400']) {
      assert.equal(runCode({ id: code }).error, null, `rejected ${code}`);
    }
  });

  test('rejects markup, control characters and quotes', () => {
    for (const bad of ['<script>', "FM'--", 'FM"X', 'FM\u0000X', 'FM%00', 'FM<>']) {
      assert.equal(runCode({ id: bad }).error?.status, 400, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test('rejects an absurdly long value', () => {
    assert.equal(runCode({ id: 'A'.repeat(200) }).error?.status, 400);
  });

  test('rejects an empty code and one starting with punctuation', () => {
    assert.equal(runCode({ id: '' }).error?.status, 400);
    assert.equal(runCode({ id: '-FM' }).error?.status, 400);
    assert.equal(runCode({ id: ' FM' }).error?.status, 400);
  });

  test('an absent parameter is not an error', () => {
    assert.equal(runCode({}, ['id']).error, null);
  });
});
