// db/syncCatalogueToGit.js
// Run with: npm run catalogue:sync
//
// One command that gets an admin's Catalogue Manager work into a state
// `git push` can carry to everyone else:
//
//   1. Export this database's catalogue to db/catalogue_export.json.
//   2. git add that file plus server/uploads/ (the actual PDF bytes).
//   3. git commit them, if there is anything to commit.
//
// It deliberately does NOT run `git push` — pushing to a shared remote should
// stay a decision a person makes on purpose.
//
// HARD STOP on an empty catalogue. The old version printed a warning and then
// committed anyway; that is precisely how an empty db/catalogue_export.json
// reached GitHub and wiped every machine that pulled it (see the notes at the
// top of exportCatalogue.js and importCatalogue.js). An empty export is never
// committed by this script now.

const { execSync } = require('child_process');
const { assertDatabaseUrl, REPO_ROOT } = require('../config/env');
const { runExport } = require('./exportCatalogue');

function sh(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

async function main() {
  const connectionString = assertDatabaseUrl();
  const { Client } = require('pg');
  const client = new Client({ connectionString });
  await client.connect();

  console.log('Exporting current catalogue from the database...');
  let result;
  try {
    result = await runExport(client);
  } finally {
    await client.end();
  }

  if (result.totalRows === 0) {
    console.error(
      '\nStopped: every catalogue table in this database is empty.\n' +
      '  Nothing was committed. Committing an empty export is what wipes the\n' +
      '  catalogue on every other machine that pulls it.\n\n' +
      '  Either you are pointed at the wrong database (check DATABASE_URL in .env),\n' +
      '  or nothing has been published yet in the Catalogue Manager.\n' +
      '  To restore the baseline catalogue here: npm run db:seed\n'
    );
    process.exit(1);
  }

  if (!result.written) {
    console.error('\nStopped: the export was refused (see the message above). Nothing was committed.');
    process.exit(1);
  }

  console.log('\nStaging db/catalogue_export.json and server/uploads/...');
  sh('git add db/catalogue_export.json server/uploads/');

  const staged = sh('git diff --cached --name-only');
  if (!staged) {
    console.log('Nothing changed since the last commit — catalogue is already up to date.');
    return;
  }

  console.log('Changed files:\n' + staged.split('\n').map((f) => '  ' + f).join('\n'));

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  sh(`git commit -m "Sync catalogue export (${stamp}, ${result.totalRows} total rows)"`);
  console.log(`\nCommitted ${result.totalRows} catalogue rows. Run "git push" now.`);
}

main().catch((err) => {
  if (err.code !== 'ENV_MISSING_DATABASE_URL') console.error('catalogue:sync failed:', err.message);
  process.exit(1);
});
