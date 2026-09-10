// db/importUploadsToDb.js
// Run with: npm run db:import-uploads
//
// One-time move of the datasheet PDFs from server/uploads/ into the
// catalogue_blobs table, so the catalogue stops being per-machine state.
//
// Run this ONCE, on the machine whose server/uploads/ folder actually has the
// files, while DATABASE_URL points at the shared database. After that, set
// STORAGE_DRIVER=db everywhere and every machine reads the same catalogue.
//
// Safe to re-run: keys are content hashes, so re-importing the same file is a
// no-op rather than a duplicate.
//
// It finishes by checking every file the DATABASE references — every
// catalogue_uploads.stored_file_url and product_catalogue_files.file_url — and
// reporting any that have no bytes behind them. That is the check that would
// have caught "Not yet uploaded to the catalogue library" showing next to a
// product whose datasheet an admin had definitely uploaded.

const { assertDatabaseUrl, uploadDir } = require('../config/env');
const db = require('../server/src/config/db');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

async function main() {
  assertDatabaseUrl();
  const dir = uploadDir();

  if (!fs.existsSync(dir)) {
    console.log(`No upload directory at ${dir} — nothing to import.`);
  } else {
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    console.log(`Importing ${files.length} file(s) from ${dir}\n`);

    let imported = 0, skipped = 0, bytesTotal = 0;
    for (const name of files) {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      const buffer = fs.readFileSync(full);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const ext = path.extname(name).toLowerCase();

      // The key must stay EXACTLY the on-disk filename: every
      // stored_file_url / file_url row already points at it. Recomputing a key
      // from the hash would orphan any file whose name drifted from its
      // content (a hand-copied or renamed file).
      const { rowCount } = await db.query(
        `INSERT INTO catalogue_blobs (storage_key, sha256, bytes, byte_size, mime_type, original_filename)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (storage_key) DO NOTHING`,
        [name, sha256, buffer, buffer.length, MIME_BY_EXT[ext] || 'application/octet-stream', name]
      );

      if (rowCount > 0) { imported++; bytesTotal += buffer.length; }
      else skipped++;

      if (name !== `${sha256}${ext}`) {
        console.warn(`  note: "${name}" is not named after its own hash — imported under its filename so existing references keep working.`);
      }
    }
    console.log(`  imported: ${imported}`);
    console.log(`  already present: ${skipped}`);
    console.log(`  bytes added: ${(bytesTotal / 1024 / 1024).toFixed(1)} MB\n`);
  }

  // --- the check that matters -------------------------------------------------
  const { rows: missing } = await db.query(`
    SELECT ref.key, ref.source, ref.product_id
      FROM (
        SELECT stored_file_url AS key, 'catalogue_uploads' AS source, product_id
          FROM catalogue_uploads
         WHERE stored_file_url IS NOT NULL AND stored_file_url NOT LIKE 'seed:%'
        UNION
        SELECT file_url AS key, 'product_catalogue_files' AS source, product_id
          FROM product_catalogue_files
         WHERE file_url IS NOT NULL AND file_url NOT LIKE 'seed:%'
      ) ref
      LEFT JOIN catalogue_blobs b ON b.storage_key = ref.key
     WHERE b.storage_key IS NULL
     ORDER BY ref.source, ref.key`);

  const { rows: stats } = await db.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(byte_size),0)::bigint AS total FROM catalogue_blobs`
  );
  console.log(`catalogue_blobs now holds ${stats[0].n} file(s), ${(Number(stats[0].total) / 1024 / 1024).toFixed(1)} MB.`);

  if (missing.length) {
    console.warn(`\n${missing.length} database reference(s) have NO bytes behind them:`);
    for (const m of missing) console.warn(`  ${m.source}${m.product_id ? ` (product ${m.product_id})` : ''}: ${m.key}`);
    console.warn(
      '\nThese will show as "no datasheet on record" in matching. Either the file was never on this\n' +
      'machine, or it was uploaded on a different one. Re-upload those datasheets in Catalogue Manager.'
    );
  } else {
    console.log('Every datasheet the database references has bytes behind it.');
  }

  console.log('\nNext: set STORAGE_DRIVER=db in .env on every machine and restart the server.');
  await db.pool.end();
}

main().catch((err) => {
  if (err.code !== 'ENV_MISSING_DATABASE_URL') console.error(err);
  process.exit(1);
});
