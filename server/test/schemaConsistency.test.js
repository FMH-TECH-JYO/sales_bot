// server/test/schemaConsistency.test.js
//
// db/migrate.js installs db/schema.sql on a FRESH database and then records
// every file in db/migrations/ as already applied, on the stated assumption
// that schema.sql is the current shape and already contains them.
//
// Nothing enforced that assumption. Migration 007 added the sessions table and
// six columns to users; schema.sql was not updated to match. The result on a
// brand-new database:
//
//     schema_migrations: 007_auth.sql  APPLIED
//     sessions table:    does not exist
//     users.password_hash: does not exist
//
// A database that reports itself fully migrated, and an application that
// cannot authenticate anyone. It passed every test, because every test ran
// against a database that had been migrated incrementally rather than
// installed fresh — which is exactly the difference between a developer
// machine and a new deployment.
//
// This test reads both sides and fails when they drift. It is a static check
// on purpose: it needs no database, so it runs everywhere, including on a
// laptop with nothing installed.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', '..', 'db');
const SCHEMA = fs.readFileSync(path.join(DB_DIR, 'schema.sql'), 'utf8');
const MIGRATIONS_DIR = path.join(DB_DIR, 'migrations');

const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/** Objects a migration brings into existence, as identifiers to look for. */
function objectsCreatedBy(sql) {
  const tables = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((m) => m[1].toLowerCase());
  const columns = [...sql.matchAll(/ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((m) => ({ table: m[1].toLowerCase(), column: m[2].toLowerCase() }));
  const indexes = [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((m) => m[1].toLowerCase());
  return { tables, columns, indexes };
}

// Objects a migration REMOVES are not expected to appear in schema.sql —
// schema.sql simply never had them. Listed explicitly so the check does not
// have to reason about drops.
const DROPPED_BY_MIGRATION = new Set(['won_lost_tracking']);

const schemaLower = SCHEMA.toLowerCase();

describe('schema.sql contains everything the migrations add', () => {
  test('there are migrations to check', () => {
    assert.ok(migrationFiles.length > 0, 'no migration files found — is the path right?');
  });

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const { tables, columns, indexes } = objectsCreatedBy(sql);

    test(`${file}: every table it creates is in schema.sql`, () => {
      for (const t of tables) {
        if (DROPPED_BY_MIGRATION.has(t)) continue;
        assert.match(
          schemaLower,
          new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${t}\\b`),
          `${file} creates table "${t}" but db/schema.sql does not.\n` +
          '  A fresh database installs schema.sql and marks this migration applied WITHOUT running it,\n' +
          `  so "${t}" would never exist there. Add it to db/schema.sql.`
        );
      }
    });

    test(`${file}: every column it adds is in schema.sql`, () => {
      for (const { table, column } of columns) {
        if (DROPPED_BY_MIGRATION.has(table)) continue;
        assert.ok(
          schemaLower.includes(column),
          `${file} adds ${table}.${column} but db/schema.sql never mentions "${column}".\n` +
          '  A fresh database would be missing that column while reporting the migration as applied.'
        );
      }
    });

    test(`${file}: every index it creates is in schema.sql`, () => {
      for (const idx of indexes) {
        assert.ok(
          schemaLower.includes(idx),
          `${file} creates index "${idx}" but db/schema.sql does not.\n` +
          '  A fresh database would run without it — correct results, quietly slower, and the\n' +
          '  UNIQUE ones are not merely a performance matter.'
        );
      }
    });
  }

  test('the auth objects specifically are present — this is the case that broke', () => {
    for (const needle of [
      'create table sessions',
      'password_hash',
      'failed_logins',
      'locked_until',
      'last_login_at',
      'users_email_lower_idx',
    ]) {
      assert.ok(schemaLower.includes(needle), `db/schema.sql is missing "${needle}"`);
    }
  });
});
