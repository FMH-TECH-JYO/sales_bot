// server/src/controllers/catalogueUploadsController.js
//
// The "upload a catalogue, it becomes a product" flow.
// Phase 3: after parsing, if a category was selected, automatically call the
// LLM to draft extracted_json + confidence_json — the admin now reviews a
// pre-filled draft instead of typing every field from scratch. If no
// category was given, or the LLM call fails for any reason (Ollama not
// running, model error, etc.), the upload still succeeds and falls back to
// Phase 2's manual-entry path — drafting is a convenience layered on top,
// never a blocker for getting the file into the system.

const db = require('../config/db');
const storage = require('../storage');
const { extractText } = require('../services/pdfParser');
const { extractProductDraft } = require('../services/extractProductDraft');
const { chunkText } = require('../services/chunkDatasheet');
const { runExport } = require('../../../db/exportCatalogue');

/** Chunk this upload's parsed text and store it immediately — the "every
 * upload feeds the RAG pipeline with chunking" step, done right at upload
 * time, before the admin has even picked a category or reviewed anything.
 * Uses the plain db (not a transaction client) since it's independent of
 * the catalogue_uploads insert's own success — a chunking failure shouldn't
 * fail the upload itself. */
async function chunkAndStoreUploadText(uploadId, text) {
  if (!text || !text.trim()) return;
  try {
    const chunks = chunkText(text);
    for (let i = 0; i < chunks.length; i++) {
      await db.query(
        `INSERT INTO catalogue_upload_chunks (catalogue_upload_id, chunk_index, content) VALUES ($1,$2,$3)`,
        [uploadId, i, chunks[i]]
      );
    }
  } catch (err) {
    console.error(`Chunking failed for catalogue_uploads id=${uploadId}:`, err.message);
  }
}

/** Keep db/catalogue_export.json up to date after EVERY successful upload,
 * not just after publish. Without this, a catalogue that's uploaded but not
 * yet reviewed/published only exists in the local Postgres DB — so pulling
 * the repo on another machine (or just sharing it with a teammate) would
 * show 0 uploads until every single one got published, which defeats the
 * point of "the admin's work should travel with the code." Best-effort:
 * export failing never fails the upload itself. */
async function exportAfterUpload(uploadId) {
  try {
    await runExport(db, { silent: true });
  } catch (exportErr) {
    console.error(`Auto-export of db/catalogue_export.json failed after upload id=${uploadId} (upload itself succeeded):`, exportErr.message);
  }
}

// POST /catalogue-uploads  (multipart, field name "file")
async function uploadCatalogue(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });

  const { url, hash } = storage.save(req.file.buffer, req.file.originalname);

  const existing = await db.query(`SELECT * FROM catalogue_uploads WHERE file_hash = $1`, [hash]);
  if (existing.rows.length > 0) {
    return res.status(200).json({ ...existing.rows[0], deduped: true });
  }

  const { text, quality } = await extractText(req.file.buffer);
  const category_id = req.body.category_id || null;

  if (quality === 'likely_scanned') {
    const inserted = await db.query(
      `INSERT INTO catalogue_uploads (original_filename, stored_file_url, file_hash, mime_type, category_id, status, raw_text)
       VALUES ($1,$2,$3,$4,$5,'uploaded',$6) RETURNING *`,
      [req.file.originalname, url, hash, req.file.mimetype, category_id, text]
    );
    await chunkAndStoreUploadText(inserted.rows[0].id, text); // usually near-empty for scanned PDFs, but chunk whatever came through
    await exportAfterUpload(inserted.rows[0].id);
    return res.status(201).json({
      ...inserted.rows[0],
      warning: 'This PDF looks scanned/image-based — little or no text was extracted. OCR support isn\'t built yet; you can still fill the product form manually.',
    });
  }

  const inserted = await db.query(
    `INSERT INTO catalogue_uploads (original_filename, stored_file_url, file_hash, mime_type, category_id, status, raw_text)
     VALUES ($1,$2,$3,$4,$5,'parsed',$6) RETURNING *`,
    [req.file.originalname, url, hash, req.file.mimetype, category_id, text]
  );
  let row = inserted.rows[0];
  await chunkAndStoreUploadText(row.id, text);

  if (category_id) {
    try {
      const { rows: catRows } = await db.query(`SELECT label FROM categories WHERE id = $1`, [category_id]);
      const categoryLabel = catRows[0]?.label || null;

      const { extracted, confidence, provider } = await extractProductDraft(text, categoryLabel);

      const updated = await db.query(
        `UPDATE catalogue_uploads
         SET extracted_json = $1, confidence_json = $2, extraction_provider = $3, status = 'drafted'
         WHERE id = $4 RETURNING *`,
        [extracted, confidence, provider, row.id]
      );
      row = updated.rows[0];
    } catch (err) {
      console.error(`Draft extraction failed for catalogue_uploads id=${row.id}:`, err.message);
      row.draft_error = err.message;
    }
  }

  await exportAfterUpload(row.id);
  res.status(201).json(row);
}

// GET /catalogue-uploads?status=parsed
async function listCatalogueUploads(req, res) {
  const { status } = req.query;
  const params = [];
  let sql = `SELECT id, original_filename, status, category_id, uploaded_at, published_at, product_id FROM catalogue_uploads`;
  if (status) {
    params.push(status);
    sql += ` WHERE status = $1`;
  }
  sql += ` ORDER BY uploaded_at DESC`;
  const { rows } = await db.query(sql, params);
  res.json(rows);
}

// GET /catalogue-uploads/:id
async function getCatalogueUpload(req, res) {
  const { rows } = await db.query(`SELECT * FROM catalogue_uploads WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}

// PATCH /catalogue-uploads/:id
async function updateDraft(req, res) {
  const { category_id, extracted_json } = req.body;
  const { rows } = await db.query(
    `UPDATE catalogue_uploads SET category_id = COALESCE($1, category_id), extracted_json = $2, status = 'in_review'
     WHERE id = $3 RETURNING *`,
    [category_id, extracted_json, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  await exportAfterUpload(rows[0].id);
  res.json(rows[0]);
}

// POST /catalogue-uploads/:id/retry-draft — re-run the LLM draft (e.g. after
// starting Ollama, or after picking a category post-upload)
async function retryDraft(req, res) {
  const { rows } = await db.query(`SELECT * FROM catalogue_uploads WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const upload = rows[0];
  const category_id = req.body.category_id || upload.category_id;
  if (!category_id) return res.status(400).json({ error: 'category_id required (pass in body or set it on the upload first)' });

  const { rows: catRows } = await db.query(`SELECT label FROM categories WHERE id = $1`, [category_id]);
  const { extracted, confidence, provider } = await extractProductDraft(upload.raw_text, catRows[0]?.label || null);

  const updated = await db.query(
    `UPDATE catalogue_uploads SET category_id=$1, extracted_json=$2, confidence_json=$3, extraction_provider=$4, status='drafted'
     WHERE id=$5 RETURNING *`,
    [category_id, extracted, confidence, provider, upload.id]
  );
  await exportAfterUpload(upload.id);
  res.json(updated.rows[0]);
}

// POST /catalogue-uploads/:id/publish
async function publishCatalogue(req, res) {
  const client = await db.pool.connect();
  try {
    const { rows } = await client.query(`SELECT * FROM catalogue_uploads WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const upload = rows[0];

    if (!upload.extracted_json || !upload.category_id) {
      return res.status(400).json({ error: 'category_id and extracted_json (product fields) must be set — PATCH this upload first with the reviewed product data.' });
    }
    const p = upload.extracted_json;
    if (!p.id || !p.family) {
      return res.status(400).json({ error: 'extracted_json must include at least { id, family } — id is the product/model code that will be used everywhere.' });
    }

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO products (id, model, family, category_id, blurb, val_min, val_max, temp_max, accuracy, output_type, hazardous, connection, no_code, datasheet_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         model=EXCLUDED.model, family=EXCLUDED.family, category_id=EXCLUDED.category_id, blurb=EXCLUDED.blurb,
         val_min=EXCLUDED.val_min, val_max=EXCLUDED.val_max, temp_max=EXCLUDED.temp_max, accuracy=EXCLUDED.accuracy,
         output_type=EXCLUDED.output_type, hazardous=EXCLUDED.hazardous, connection=EXCLUDED.connection,
         datasheet_text=EXCLUDED.datasheet_text, updated_at=CURRENT_TIMESTAMP`,
      [p.id, p.model || p.id, p.family, upload.category_id, p.blurb || '', p.val_min ?? null, p.val_max ?? null,
       p.temp_max ?? null, p.accuracy || null, p.output_type || 'visual', p.hazardous || 'safe', p.connection || null, false,
       upload.raw_text || null]
    );

    for (const industry of p.industries || []) {
      await client.query(`INSERT INTO product_industries (product_id, industry) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [p.id, industry]);
    }

    // Family-specific attributes (RTD wiring, switch differential, level
    // measurement principle, indicator power type, etc.) that don't have a
    // fixed products column — full replace on each (re-)publish so editing
    // one in the review screen doesn't leave a stale duplicate behind.
    await client.query(`DELETE FROM product_extra_spec WHERE product_id = $1`, [p.id]);
    for (const spec of p.extra_specs || []) {
      if (!spec?.label || !spec?.value) continue;
      await client.query(
        `INSERT INTO product_extra_spec (product_id, label, value) VALUES ($1,$2,$3)
         ON CONFLICT (product_id, label) DO UPDATE SET value = EXCLUDED.value`,
        [p.id, spec.label, spec.value]
      );
    }

    // RAG chunks: full replace on every (re-)publish, same pattern as
    // extra_specs above. Prefer copying the chunks already computed at
    // upload time (catalogue_upload_chunks) — cheap, and keeps chunk
    // boundaries identical to what was chunked at ingest; only re-chunk
    // from raw_text directly as a fallback for uploads from before that
    // step existed (pre-migration data with no upload-time chunks yet).
    await client.query(`DELETE FROM product_datasheet_chunks WHERE product_id = $1`, [p.id]);
    const { rows: uploadChunkRows } = await client.query(
      `SELECT chunk_index, content FROM catalogue_upload_chunks WHERE catalogue_upload_id = $1 ORDER BY chunk_index`,
      [upload.id]
    );
    if (uploadChunkRows.length > 0) {
      for (const c of uploadChunkRows) {
        await client.query(
          `INSERT INTO product_datasheet_chunks (product_id, chunk_index, content) VALUES ($1,$2,$3)`,
          [p.id, c.chunk_index, c.content]
        );
      }
    } else if (upload.raw_text) {
      const chunks = chunkText(upload.raw_text);
      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO product_datasheet_chunks (product_id, chunk_index, content) VALUES ($1,$2,$3)`,
          [p.id, i, chunks[i]]
        );
      }
    }

    await client.query(`UPDATE product_catalogue_files SET is_current = FALSE WHERE product_id = $1`, [p.id]);
    const { rows: fileRows } = await client.query(
      `SELECT COALESCE(MAX(version),0)+1 AS next_version FROM product_catalogue_files WHERE product_id = $1`, [p.id]
    );
    await client.query(
      `INSERT INTO product_catalogue_files (product_id, file_url, version, uploaded_by, is_current) VALUES ($1,$2,$3,$4,TRUE)`,
      [p.id, upload.stored_file_url, fileRows[0].next_version, req.body.reviewed_by || null]
    );

    await client.query(
      `UPDATE catalogue_uploads SET status='published', product_id=$1, published_at=CURRENT_TIMESTAMP, reviewed_by=$2, reviewed_at=CURRENT_TIMESTAMP WHERE id=$3`,
      [p.id, req.body.reviewed_by || null, upload.id]
    );

    await client.query('COMMIT');

    // Keep db/catalogue_export.json always up to date on disk so the admin
    // never has to remember to run `npm run db:export-catalogue` before
    // committing/pushing — this was the #1 way "catalogue shows empty after
    // pulling on another machine" happened: the DB export step got missed.
    // Best-effort: a failure here doesn't undo the publish (already
    // committed above), it just means db/catalogue_export.json is stale
    // until the next publish or a manual `npm run db:export-catalogue`.
    try {
      await runExport(db, { silent: true });
    } catch (exportErr) {
      console.error('Auto-export of db/catalogue_export.json failed after publish (publish itself succeeded):', exportErr.message);
    }

    res.json({ published: true, product_id: p.id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// POST /catalogue-uploads/:id/reject
async function rejectCatalogue(req, res) {
  const { rows } = await db.query(
    `UPDATE catalogue_uploads SET status='rejected', reviewed_by=$1, reviewed_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *`,
    [req.body.reviewed_by || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  await exportAfterUpload(rows[0].id);
  res.json(rows[0]);
}

// GET /catalogue-uploads/:id/file — view the original uploaded PDF (before it's published)
async function viewCatalogueFile(req, res) {
  const { rows } = await db.query(`SELECT stored_file_url, original_filename FROM catalogue_uploads WHERE id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  if (!storage.exists(rows[0].stored_file_url)) {
    return res.status(404).json({
      error: `File "${rows[0].original_filename}" is missing from this server's storage (expected key ${rows[0].stored_file_url}). ` +
        `The upload record exists in the database, but the PDF isn't on disk — see DEPLOY.md's "moving this app to another machine" section.`,
    });
  }
  const buffer = storage.getBuffer(rows[0].stored_file_url);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rows[0].original_filename}"`);
  res.send(buffer);
}

module.exports = {
  uploadCatalogue, listCatalogueUploads, getCatalogueUpload, updateDraft, retryDraft, publishCatalogue, rejectCatalogue, viewCatalogueFile,
};