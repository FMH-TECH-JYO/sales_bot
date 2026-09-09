// db/backfillDatasheetChunks.js
// Run with: node db/backfillDatasheetChunks.js   (or: npm run db:backfill-chunks)
//
// One-off catch-up for catalogues that were published (or PDFs uploaded)
// BEFORE the chunked RAG pipeline existed, so they have raw text but no
// rows yet in product_datasheet_chunks / catalogue_upload_chunks. Safe to
// re-run any time — it only fills in what's missing, never touches a
// product/upload that already has chunks (re-publishing a catalogue is
// what refreshes those; see publishCatalogue() in
// catalogueUploadsController.js).

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');
const { chunkText } = require('../server/src/services/chunkDatasheet');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const { rows: products } = await client.query(`
      SELECT p.id, p.datasheet_text
      FROM products p
      LEFT JOIN product_datasheet_chunks c ON c.product_id = p.id
      WHERE p.datasheet_text IS NOT NULL AND p.datasheet_text != ''
      GROUP BY p.id, p.datasheet_text
      HAVING COUNT(c.id) = 0
    `);
    console.log(`Products needing chunk backfill: ${products.length}`);
    for (const p of products) {
      const chunks = chunkText(p.datasheet_text);
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO product_datasheet_chunks (product_id, chunk_index, content) VALUES ($1,$2,$3)`,
          [p.id, i, chunks[i]]
        );
      }
      console.log(`  ${p.id}: ${chunks.length} chunks`);
    }

    const { rows: uploads } = await client.query(`
      SELECT u.id, u.raw_text
      FROM catalogue_uploads u
      LEFT JOIN catalogue_upload_chunks c ON c.catalogue_upload_id = u.id
      WHERE u.raw_text IS NOT NULL AND u.raw_text != ''
      GROUP BY u.id, u.raw_text
      HAVING COUNT(c.id) = 0
    `);
    console.log(`Catalogue uploads needing chunk backfill: ${uploads.length}`);
    for (const u of uploads) {
      const chunks = chunkText(u.raw_text);
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO catalogue_upload_chunks (catalogue_upload_id, chunk_index, content) VALUES ($1,$2,$3)`,
          [u.id, i, chunks[i]]
        );
      }
      console.log(`  upload#${u.id}: ${chunks.length} chunks`);
    }

    console.log('\nBackfill complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
