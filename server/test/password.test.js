// server/test/password.test.js
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, verifyPassword, assertUsablePassword, MIN_LENGTH } = require('../src/services/password');

describe('password hashing', () => {
  test('a correct password verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  test('a wrong password does not', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery stapl', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  test('the same password hashes differently every time', async () => {
    // A per-password random salt is what stops one rainbow table from covering
    // every account, and stops two colleagues who chose the same password from
    // being visibly identical in a database dump.
    const a = await hashPassword('the same password twice');
    const b = await hashPassword('the same password twice');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('the same password twice', a), true);
    assert.equal(await verifyPassword('the same password twice', b), true);
  });

  test('the stored form records its own cost parameters', async () => {
    const hash = await hashPassword('a perfectly fine password');
    const [scheme, N, r, p] = hash.split('$');
    assert.equal(scheme, 'scrypt');
    assert.equal(Number(N), 32768);
    assert.equal(Number(r), 8);
    assert.equal(Number(p), 1);
    assert.equal(hash.split('$').length, 6);
  });

  test('the plaintext never appears in the stored hash', async () => {
    const hash = await hashPassword('sup3rsecret-passphrase');
    assert.equal(hash.includes('sup3rsecret'), false);
  });

  // A user row that has never had a password set must not be loggable into.
  // This is the case for every row that existed before migration 007.
  test('a null or empty stored hash always fails, and does not throw', async () => {
    assert.equal(await verifyPassword('anything at all', null), false);
    assert.equal(await verifyPassword('anything at all', ''), false);
    assert.equal(await verifyPassword('anything at all', undefined), false);
  });

  test('a garbled stored hash fails closed rather than throwing', async () => {
    for (const bad of ['not-a-hash', 'scrypt$$$$', 'scrypt$x$8$1$AAAA$AAAA', 'bcrypt$1$2$3$4$5', '$$$$$']) {
      assert.equal(await verifyPassword('anything at all', bad), false, `should reject: ${bad}`);
    }
  });

  test('a hostile stored hash cannot demand unbounded memory', async () => {
    // N = 2^30 would try to allocate ~1 TB. Rejected on its parameters, before
    // any allocation, so a poisoned row is a failed login and not a crashed
    // process.
    const hostile = `scrypt$${2 ** 30}$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA`;
    assert.equal(await verifyPassword('anything at all', hostile), false);
  });

  test('unicode passwords are normalised, so the same keystrokes always work', async () => {
    // 'é' can be one code point or 'e' + a combining accent. A password typed
    // on macOS and re-typed on Windows can differ byte-for-byte while looking
    // identical; NFKC normalisation makes both verify.
    const composed = 'password\u00e9-long-enough';        // \u00e9 as one code point
    const decomposed = 'passworde\u0301-long-enough';    // 'e' + combining acute
    assert.notEqual(composed, decomposed);               // different byte sequences…
    const hash = await hashPassword(composed);
    assert.equal(await verifyPassword(decomposed, hash), true);
  });

  test(`passwords shorter than ${MIN_LENGTH} characters are refused with a 400`, () => {
    // .status = 400 matters as much as the throw itself: without it the error
    // handler treats a user's short password as a server fault and returns 500.
    assert.throws(
      () => assertUsablePassword('short'),
      (err) => err.status === 400
        && err.code === 'WEAK_PASSWORD'
        && new RegExp(String(MIN_LENGTH)).test(err.message)
    );
  });

  test('an enormous password is refused rather than occupying a core', async () => {
    // Unbounded input into a deliberately slow KDF is a denial-of-service
    // vector, so the length cap is a security control, not tidiness.
    await assert.rejects(
      () => hashPassword('x'.repeat(2000)),
      (err) => err.status === 400 && err.code === 'PASSWORD_TOO_LONG'
    );
  });

  test('a password of exactly the minimum length is accepted', async () => {
    const exact = 'a'.repeat(MIN_LENGTH);
    assert.doesNotThrow(() => assertUsablePassword(exact));
    assert.equal(await verifyPassword(exact, await hashPassword(exact)), true);
  });
});
