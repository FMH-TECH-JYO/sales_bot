// server/test/productRoutes.test.js
//
// This file exists because of a regression introduced while fixing something
// else. A numeric path validator was added to /products/:id on the assumption
// that every id in this schema is a serial integer. It is not:
//
//     products.id  -> TEXT   ('FMLG-BM', 'FMDPT-6000', 'FD')
//     enquiries.id -> INTEGER
//
// so the validator rejected every real product with a 400. Nothing caught it,
// because no test had ever fetched a product by its actual id.
//
// The rule these tests encode: a route test must use a value the DATABASE
// would actually produce, not one that looks plausible.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startServer, stopServer, createTestUser, cleanupTestData, call, signIn, db } = require('./helpers');

// One server and one pool for the whole FILE. Per-describe teardown closed the
// pool while the next describe was still using it — "Cannot use a pool after
// calling end on the pool" — which reads like a product bug and is not one.
let token;
let realProduct;

before(async () => {
  await startServer();
  const engineer = await createTestUser({ role: 'sales_engineer' });
  token = (await signIn(engineer)).token;

  const { rows } = await db.query('SELECT id, model, category_id FROM products ORDER BY id LIMIT 1');
  realProduct = rows[0];
});

after(async () => {
  await cleanupTestData();
  await stopServer();
  await db.pool.end();
});

describe('product routes use real product codes', () => {

  test('the catalogue is not empty — otherwise the rest of this file proves nothing', () => {
    assert.ok(realProduct, 'no products in the database; run `npm run setup` first');
  });

  test('product ids are text codes, not integers', () => {
    // Stated as an assertion so that if the schema ever changes to a serial,
    // this file fails loudly instead of quietly testing the wrong thing.
    assert.equal(typeof realProduct.id, 'string');
    assert.equal(/^\d+$/.test(realProduct.id), false,
      `product id "${realProduct.id}" is all digits — check whether the schema changed`);
  });

  test('GET /products/:id works with a real product code', async () => {
    const res = await call(`/products/${encodeURIComponent(realProduct.id)}`, { token });
    assert.equal(res.status, 200, `real product code was rejected: ${res.text.slice(0, 200)}`);
    assert.equal(res.body.id, realProduct.id);
  });

  test('GET /products/:id/catalogue works with a real product code', async () => {
    const res = await call(`/products/${encodeURIComponent(realProduct.id)}/catalogue`, { token });
    // 200 with the file, or 404 with an explanation when no datasheet has been
    // uploaded for that product. Both are correct; 400 is not, because a 400
    // means the code was rejected before anything was looked up.
    assert.notEqual(res.status, 400, `real product code was rejected: ${res.text.slice(0, 200)}`);
    assert.ok([200, 404].includes(res.status), `unexpected ${res.status}: ${res.text.slice(0, 200)}`);
  });

  test('GET /offers/fields/:productId works with a real product code', async () => {
    const res = await call(`/offers/fields/${encodeURIComponent(realProduct.id)}`, { token });
    assert.notEqual(res.status, 400, `real product code was rejected: ${res.text.slice(0, 200)}`);
  });

  test('an unknown but well-formed code is a 404, not a 400', async () => {
    // "I do not have that product" and "that is not a product code" are
    // different answers and the engineer needs to be able to tell them apart.
    const res = await call('/products/FMXX-9999', { token });
    assert.equal(res.status, 404);
  });

  test('a malformed code is a 400, and never reaches the database', async () => {
    for (const bad of ['<script>', 'a'.repeat(200), '%00', "'; DROP TABLE products; --"]) {
      const res = await call(`/products/${encodeURIComponent(bad)}`, { token });
      assert.equal(res.status, 400, `accepted malformed code ${JSON.stringify(bad)}`);
    }
  });

  test('the catalogue still lists every product', async () => {
    const res = await call('/products', { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length > 0, 'the product list came back empty');
  });
});

describe('integer-keyed routes still validate as integers', () => {

  test('GET /enquiries/notanumber is a 400, not a 500', async () => {
    // The original defect: this reached Postgres as WHERE id = 'notanumber',
    // raised 22P02, and came back as a 500 with the raw error text attached.
    const res = await call('/enquiries/notanumber', { token });
    assert.equal(res.status, 400);
  });

  test('GET /enquiries/<huge> is a 400, not a 500', async () => {
    const res = await call('/enquiries/99999999999999', { token });
    assert.equal(res.status, 400);
  });

  test('GET /enquiries/<valid but absent> is a 404', async () => {
    const res = await call('/enquiries/2147483647', { token });
    assert.equal(res.status, 404);
  });
});
