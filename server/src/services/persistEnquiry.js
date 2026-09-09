// server/src/services/persistEnquiry.js
//
// Writes an enquiry, its line items and every ranked match to the database.
//
// Before this file existed, nothing in the app persisted anything:
// enquiriesController.match() ran the whole matching pipeline, returned JSON to
// the browser and forgot it. Close the tab and the enquiry never happened —
// no history, no demand signal, no way to measure match quality, and nothing
// for an offer to reference. Every analytics requirement depends on this.
//
// Design notes:
//   * One transaction for the whole enquiry. A half-saved enquiry (line items
//     with no matches, or vice versa) would silently corrupt every count built
//     on top of it, so it is all or nothing.
//   * matches.deviations_json is a SNAPSHOT taken at match time. The catalogue
//     changes; an offer issued in March must still show what was actually
//     quoted then. Same reasoning as offer_line_items.unit_price.
//   * Persistence NEVER fails the user's request. Matching already succeeded by
//     the time this runs — refusing to show the engineer their results because
//     a write failed would be a worse outcome than a missing history row. The
//     caller logs and continues; see enquiriesController.js.
//   * uploaded_by is null until authentication exists. The column is nullable
//     on purpose so persistence can land before auth does.

const db = require('../config/db');

/** Map an upload (or absence of one) onto the enquiries.source_type enum. */
function detectSourceType(file) {
  if (!file) return 'text';
  const name = (file.originalname || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf')) return 'pdf_native';
  if (mime.includes('spreadsheet') || mime.includes('ms-excel') || /\.xlsx?$/.test(name)) return 'xlsx';
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.docx') || name.endsWith('.docm')) return 'docx';
  return 'text';
}

function detectSourceQuality(sourceType, rawText) {
  if (sourceType === 'text') return 'clean_text';
  if (sourceType === 'xlsx' || sourceType === 'csv') return 'table';
  if (sourceType === 'pdf_native') {
    // pdfParser.js flags scans by character density; without it plumbed through
    // yet, a near-empty extraction from a PDF is the same signal.
    return (rawText || '').trim().length < 200 ? 'ocr_pdf' : 'native_pdf';
  }
  return null;
}

/**
 * Store the uploaded enquiry file so the original is recoverable later.
 * Best-effort: a storage failure must not lose the enquiry record itself.
 * @returns {string|null} storage key for enquiries.source_file_url
 */
function storeSourceFile(file) {
  if (!file || !file.buffer) return null;
  try {
    const storage = require('../storage');
    const { url } = storage.save(file.buffer, file.originalname, file.mimetype);
    return url;
  } catch (err) {
    console.error('Could not store enquiry source file (enquiry still saved):', err.message);
    return null;
  }
}

/**
 * @param {object} args
 * @param {string} args.text            typed text that accompanied the enquiry
 * @param {object} args.result          return value of matchEnquiries()
 * @param {object} [args.file]          multer file, if one was uploaded
 * @param {number} [args.userId]        null until auth exists
 * @param {string} [args.customerName]
 * @returns {Promise<{enquiryId: number, lineItemIds: number[], matchCount: number}>}
 */
async function persistEnquiry({ text, result, file, userId = null, customerName = null }) {
  const sourceType = detectSourceType(file);
  const rawText = [text, ...(result.items || []).map((i) => i.text)].filter(Boolean).join('\n\n');
  const sourceQuality = detectSourceQuality(sourceType, rawText);
  const sourceFileUrl = storeSourceFile(file);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: enquiryRows } = await client.query(
      `INSERT INTO enquiries
         (source_file_url, source_filename, source_type, source_quality, raw_text,
          uploaded_by, customer_name, split_method, stage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new')
       RETURNING id`,
      [
        sourceFileUrl,
        file?.originalname || null,
        sourceType,
        sourceQuality,
        rawText,
        userId,
        customerName,
        result.splitMethod || 'single',
      ]
    );
    const enquiryId = enquiryRows[0].id;

    await client.query(
      `INSERT INTO enquiry_stage_history (enquiry_id, from_stage, to_stage, changed_by)
       VALUES ($1, NULL, 'new', $2)`,
      [enquiryId, userId]
    );

    const lineItemIds = [];
    let matchCount = 0;

    for (const item of result.items || []) {
      // extracted_json holds everything the pipeline understood about this line
      // — the parsed specs plus the clarifications it could not resolve. Kept
      // as one JSONB blob rather than columns because the useful fields differ
      // per product family and will keep changing.
      const extracted = {
        text: item.text,
        parsed: item.parsed || null,
        categorySource: item.categorySource || null,
        clarificationsNeeded: item.clarificationsNeeded || [],
        warning: item.warning || null,
      };

      const { rows: liRows } = await client.query(
        `INSERT INTO enquiry_line_items
           (enquiry_id, category_id, extracted_json, extraction_provider,
            line_index, source_excerpt, source_ref, tag_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id`,
        [
          enquiryId,
          item.categoryId || null,
          JSON.stringify(extracted),
          item.provider || null,
          item.index ?? null,
          item.sourceExcerpt || null,
          item.sourceRef || null,
          item.parsed?.tagNo || null,
        ]
      );
      const lineItemId = liRows[0].id;
      lineItemIds.push(lineItemId);

      const results = (item.results || []).filter((r) => r && r.product && r.product.id);
      for (let rank = 0; rank < results.length; rank++) {
        const r = results[rank];
        const criteria = {
          band: r.band || null,
          reason: r.reason || null,
          matchingSpecs: r.matchingSpecs || [],
          missingSpecs: r.missingSpecs || [],
          datasheetFindings: r.datasheetFindings || [],
          sources: r.sources || [],
        };
        // The deviations the engineer was actually shown, frozen at match time.
        const deviations = {
          deviations: r.deviations || [],
          requestedVsActual: r.requestedVsActual || [],
        };

        await client.query(
          `INSERT INTO matches
             (line_item_id, product_id, percent_match, criteria_scores, deviations_json, rank)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [lineItemId, r.product.id, r.percent ?? 0, JSON.stringify(criteria), JSON.stringify(deviations), rank + 1]
        );
        matchCount++;
      }
    }

    await client.query(
      `INSERT INTO audit_log (entity_type, entity_id, actor, action, diff_json)
       VALUES ('enquiry', $1, $2, 'create', $3)`,
      [
        String(enquiryId),
        userId,
        JSON.stringify({ itemCount: result.itemCount || 0, matchCount, sourceType, splitMethod: result.splitMethod }),
      ]
    );

    await client.query('COMMIT');
    return { enquiryId, lineItemIds, matchCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { persistEnquiry, detectSourceType, detectSourceQuality };
