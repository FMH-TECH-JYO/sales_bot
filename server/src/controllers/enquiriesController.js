// server/src/controllers/enquiriesController.js
const { matchEnquiries } = require('../services/matchEnquiry');
const { persistEnquiry } = require('../services/persistEnquiry');
const db = require('../config/db');

// POST /enquiries/match
// Accepts EITHER:
//   - JSON body { text, attachmentNames?, customerName? }  (typed text only)
//   - multipart/form-data with field "file" (PDF or Excel) and optional
//     field "text" (any typed note to go alongside it)
// A single request can produce MULTIPLE match results — one per enquiry
// found in the text/file.
// Response shape: { enquiryId, persisted, text, items: [...], itemCount }
async function match(req, res) {
  const text = (req.body?.text || '').trim();
  const customerName = (req.body?.customerName || '').trim() || null;
  let attachmentNames = [];
  if (req.body?.attachmentNames) {
    try {
      attachmentNames = Array.isArray(req.body.attachmentNames)
        ? req.body.attachmentNames
        : JSON.parse(req.body.attachmentNames);
    } catch {
      attachmentNames = [];
    }
  }
  if (req.file) attachmentNames = [...attachmentNames, req.file.originalname];

  if (!text && !req.file) {
    return res.status(400).json({ error: 'text or file is required' });
  }

  const result = await matchEnquiries(text, { file: req.file, attachmentNames });

  if (result.itemCount === 0) {
    return res.status(422).json({
      error: result.fileWarning || 'Could not extract any enquiries from the supplied text/file.',
    });
  }

  // Persist the enquiry, its line items and every ranked match — with the
  // deviations exactly as shown here, snapshotted.
  //
  // Deliberately NON-fatal. Matching has already succeeded and the engineer is
  // waiting on it; losing a history row is bad, but refusing to show someone
  // their results because of a failed INSERT is worse. The error is logged
  // loudly and the response carries persisted:false so the UI can say this one
  // won't appear in history.
  let enquiryId = null;
  let persisted = true;
  try {
    const saved = await persistEnquiry({ text, result, file: req.file, customerName, userId: req.user.id });
    enquiryId = saved.enquiryId;
  } catch (err) {
    persisted = false;
    console.error('Failed to persist enquiry (results still returned to the user):', err);
  }

  res.json({ enquiryId, persisted, text, ...result });
}

// GET /enquiries — history, newest first. The foundation of every analytics
// view; until persistEnquiry existed there was simply nothing to list.
async function list(req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const { rows } = await db.query(
    `SELECT e.id, e.customer_name, e.source_filename, e.source_type, e.source_quality,
            e.stage, e.uploaded_at,
            COUNT(DISTINCT li.id)::int AS item_count,
            COUNT(m.id)::int           AS match_count
       FROM enquiries e
       LEFT JOIN enquiry_line_items li ON li.enquiry_id = e.id
       LEFT JOIN matches m             ON m.line_item_id = li.id
      GROUP BY e.id
      ORDER BY e.uploaded_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json(rows);
}

// GET /enquiries/:id — one enquiry with its line items and ranked matches,
// including the deviations snapshot taken at match time.
async function get(req, res) {
  const { rows: enquiryRows } = await db.query('SELECT * FROM enquiries WHERE id = $1', [req.params.id]);
  if (!enquiryRows.length) return res.status(404).json({ error: 'Enquiry not found' });

  const { rows: items } = await db.query(
    `SELECT id, category_id, extracted_json, extraction_provider, line_index,
            source_excerpt, source_ref, tag_no
       FROM enquiry_line_items WHERE enquiry_id = $1 ORDER BY line_index NULLS LAST, id`,
    [req.params.id]
  );

  const ids = items.map((i) => i.id);
  const { rows: matches } = ids.length
    ? await db.query(
        `SELECT m.*, p.model, p.family
           FROM matches m
           JOIN products p ON p.id = m.product_id
          WHERE m.line_item_id = ANY($1::int[])
          ORDER BY m.line_item_id, m.rank`,
        [ids]
      )
    : { rows: [] };

  res.json({
    ...enquiryRows[0],
    items: items.map((i) => ({ ...i, matches: matches.filter((m) => m.line_item_id === i.id) })),
  });
}

module.exports = { match, list, get };
