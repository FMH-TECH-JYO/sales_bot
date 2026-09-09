// db/syncCatalogueToGit.js
// Run with: npm run catalogue:sync
//
// One command that does everything needed to get an admin's Catalogue
// Manager uploads into a state `git push` can carry to everyone else:
//
//   1. Export the current database's catalogue tables to
//      db/catalogue_export.json (same as `npm run db:export-catalogue`,
//      reusing that exact script so there's only one place this logic lives).
//   2. `git add` that file plus server/uploads/ (the actual PDF bytes).
//   3. `git commit` them, IF there's actually something to commit.
//
// Why this exists: catalogueUploadsController.js already calls the same
// export after every upload/publish/reject, so db/catalogue_export.json is
// normally already current on disk. What was missing was a single obvious
// step to get it staged and committed — this is that step. It deliberately
// does NOT run `git push` — pushing to a shared remote should stay a
// decision a person makes on purpose (right branch, ready to share), not
// something a script does silently. Run `git push` yourself right after
// this finishes.
//
// Safe to run any time, including with nothing new to commit — it'll just
// say so and exit cleanly instead of creating an empty commit.

const { execSync } = require('child_process');
const path = require('path');
const { runExport } = require('./exportCatalogue');

const REPO_ROOT = path.join(__dirname, '..');

function sh(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('Exporting current catalogue from the database...');
  const dump = await runExport(client);
  await client.end();

  const totalRows = Object.values(dump).reduce((sum, rows) => sum + rows.length, 0);
  if (totalRows === 0) {
    console.log(
      '\nWarning: every catalogue table is empty. db/catalogue_export.json was written, ' +
      'but it has nothing real in it — committing it now would just push an empty catalogue. ' +
      'Upload/publish something in the Catalogue Manager first, or confirm you\'re pointed at ' +
      'the right database (.env DATABASE_URL), then re-run this.'
    );
  }

  console.log('\nStaging db/catalogue_export.json and server/uploads/...');
  sh('git add db/catalogue_export.json server/uploads/');

  const staged = sh('git diff --cached --name-only');
  if (!staged) {
    console.log('Nothing changed since the last commit — catalogue is already up to date. Nothing to commit.');
    return;
  }

  console.log('Changed files:\n' + staged.split('\n').map((f) => '  ' + f).join('\n'));

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  sh(`git commit -m "Sync catalogue export (${stamp}, ${totalRows} total rows)"`);
  console.log(
    `\nCommitted. Run "git push" now to make this catalogue visible to anyone who pulls the repo next.`
  );
}

main().catch((err) => {
  console.error('catalogue:sync failed:', err.message);
  process.exit(1);
});
