// db/createUser.js
// Run with: npm run user:create -- --email you@forbesmarshall.com --name "Your Name" --role admin
//
// Creates the first administrator, or resets any account's password, from the
// command line. This exists because the alternative — shipping a default
// admin account with a known password — is the single most common way a
// deployed application gets taken over, and because there has to be SOME way
// to create the very first admin before any admin exists to create one.
//
// The password is read from stdin (or generated) rather than taken as a
// command-line argument on purpose: argv is visible to every other process on
// the machine via `ps`, and lands in the shell history file.
//
// Re-running for an existing email updates that user's password and role
// rather than failing, so it doubles as "I locked myself out".

const { assertDatabaseUrl } = require('../config/env');
const crypto = require('crypto');
const readline = require('readline');
const db = require('../server/src/config/db');
const { hashPassword, MIN_LENGTH } = require('../server/src/services/password');
const { revokeAllForUser } = require('../server/src/services/sessions');

const ROLES = ['sales_engineer', 'manager', 'admin'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/** Read a line from stdin without echoing it to the terminal. Falls back to a
 * visible prompt when stdin is not a TTY (a pipe, or CI), because muting a
 * non-TTY silently discards the input. */
function askHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Redraw the prompt with no characters after it, so nothing is echoed.
      if (['\n', '\r', ''].includes(String(char))) process.stdin.removeListener('data', onData);
      else readline.clearLine(process.stdout, 0), readline.cursorTo(process.stdout, 0), process.stdout.write(question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  assertDatabaseUrl();
  const args = parseArgs(process.argv.slice(2));

  const email = String(args.email || '').trim().toLowerCase();
  const name = String(args.name || '').trim();
  const role = String(args.role || 'sales_engineer');

  if (!email || !name) {
    console.error('Usage: npm run user:create -- --email <email> --name "<Full Name>" [--role admin] [--generate]');
    console.error(`  --role must be one of: ${ROLES.join(', ')} (default sales_engineer)`);
    console.error('  --generate prints a strong random password instead of prompting for one');
    process.exit(2);
  }
  if (!ROLES.includes(role)) {
    console.error(`Role must be one of: ${ROLES.join(', ')}`);
    process.exit(2);
  }

  let password;
  let generated = false;
  if (args.generate) {
    // 24 base64url characters ≈ 143 bits. Long enough that it never needs rotating
    // for strength reasons, short enough to retype once into a password manager.
    password = crypto.randomBytes(18).toString('base64url');
    generated = true;
  } else {
    password = await askHidden(`Password for ${email} (min ${MIN_LENGTH} chars, not echoed): `);
    const confirm = await askHidden('Repeat it: ');
    if (password !== confirm) {
      console.error('The two passwords do not match. Nothing was changed.');
      process.exit(1);
    }
  }

  const hash = await hashPassword(password);   // throws with a clear message if too short

  const { rows } = await db.query(
    `INSERT INTO users (name, email, role, active, password_hash)
     VALUES ($1, $2, $3, TRUE, $4)
     ON CONFLICT (email) DO UPDATE
       SET name = EXCLUDED.name,
           role = EXCLUDED.role,
           active = TRUE,
           password_hash = EXCLUDED.password_hash,
           failed_logins = 0,
           locked_until = NULL
     RETURNING id, name, email, role, (xmax = 0) AS inserted`,
    [name, email, role, hash]
  );

  const user = rows[0];
  // Any session that existed under the old password must die with it.
  if (!user.inserted) await revokeAllForUser(user.id);

  console.log(`${user.inserted ? 'Created' : 'Updated'} ${user.role} account: ${user.email} (id ${user.id})`);
  if (generated) {
    console.log(`\n  Password: ${password}\n`);
    console.log('  This is shown once. Store it in a password manager now — it is not recoverable,');
    console.log('  only replaceable by re-running this command.');
  }
  if (!user.inserted) console.log('All existing sessions for this account have been signed out.');

  await db.pool.end();
}

main().catch((err) => {
  if (err.code !== 'ENV_MISSING_DATABASE_URL') console.error(err.message || err);
  process.exit(1);
});
