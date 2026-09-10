// server/src/services/password.js
//
// Password hashing with scrypt from Node's own crypto module.
//
// Why scrypt and not bcrypt/argon2: both of those are native addons. This
// repo already ships to three machines (two Windows working copies and a
// Linux container) and adding a package that has to compile at install time
// is a reliable way to produce "npm install works on my machine". scrypt is
// built into Node, is memory-hard, and is an accepted password KDF (RFC 7914,
// and listed by OWASP as an acceptable alternative to argon2id).
//
// Parameters: N=2^15 (32768), r=8, p=1 — the OWASP minimum for scrypt is
// N=2^15/r=8/p=3 with 64 MiB, but p only adds CPU, not memory, and Node's
// default maxmem (32 MiB) has to be raised for N=2^15 at all. We raise maxmem
// explicitly to 64 MiB and keep p=1, which costs roughly 100 ms per hash on a
// modern server core. That is deliberately slow: the whole point is that an
// attacker with the hash file cannot try many candidates per second.
//
// Stored format is self-describing, so the cost parameters can be raised later
// without invalidating existing hashes:
//     scrypt$N$r$p$<salt base64>$<derived key base64>

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const N = 32768;
const r = 8;
const p = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
// scrypt needs roughly 128 * N * r bytes; 128 * 32768 * 8 = 32 MiB, which is
// exactly Node's default limit, so it would throw without headroom.
const MAXMEM = 96 * 1024 * 1024;

/**
 * @param {string} plain
 * @returns {Promise<string>} encoded hash safe to store in users.password_hash
 */
async function hashPassword(plain) {
  assertUsablePassword(plain);
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(plain.normalize('NFKC'), salt, KEY_LEN, { N, r, p, maxmem: MAXMEM });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Constant-time verification.
 *
 * Returns false — never throws — for a null/empty/garbled stored hash, so a
 * user row that has never had a password set simply cannot log in. Throwing
 * here would turn "this account has no password" into a 500 and would leak,
 * through the difference between a 500 and a 401, which accounts exist.
 *
 * @param {string} plain
 * @param {string|null} stored
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || !plain) return false;
  if (typeof stored !== 'string' || !stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nStr, rStr, pStr, saltB64, keyB64] = parts;
  const nUsed = Number(nStr);
  const rUsed = Number(rStr);
  const pUsed = Number(pStr);
  if (!Number.isInteger(nUsed) || !Number.isInteger(rUsed) || !Number.isInteger(pUsed)) return false;
  // Guard against a hostile row asking for an unbounded amount of memory.
  if (nUsed > 1 << 20 || rUsed > 32 || pUsed > 16) return false;

  let expected;
  let actual;
  try {
    expected = Buffer.from(keyB64, 'base64');
    actual = await scrypt(plain.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: nUsed, r: rUsed, p: pUsed, maxmem: MAXMEM,
    });
  } catch {
    return false;
  }
  if (expected.length !== actual.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(expected, actual);
}

const MIN_LENGTH = 12;

/**
 * Rejects passwords that are too short to be worth hashing.
 *
 * Length only. Composition rules ("one uppercase, one digit, one symbol")
 * push people towards P@ssw0rd1 and are explicitly discouraged by NIST
 * SP 800-63B; a 12-character minimum with no character-class requirement is
 * that document's recommendation.
 *
 * @throws {Error} with .status = 400 so the API returns a 400, not a 500
 */
function assertUsablePassword(plain) {
  if (typeof plain !== 'string' || plain.normalize('NFKC').length < MIN_LENGTH) {
    const err = new Error(`Password must be at least ${MIN_LENGTH} characters.`);
    err.status = 400;
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  if (Buffer.byteLength(plain, 'utf8') > 1024) {
    // Unbounded input into a deliberately slow KDF is a denial-of-service
    // vector: a 1 MB "password" would occupy a core for a long time.
    const err = new Error('Password must be at most 1024 bytes.');
    err.status = 400;
    err.code = 'PASSWORD_TOO_LONG';
    throw err;
  }
}

module.exports = { hashPassword, verifyPassword, assertUsablePassword, MIN_LENGTH };
