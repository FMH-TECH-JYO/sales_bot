// server/src/services/internalDatasheetLookup.js
//
// The "if information is missing from the structured fields, retrieve
// reliable information from elsewhere" requirement — kept entirely
// internal, no internet. When matchEnquiry.js finds a spec the enquiry
// asked about that neither a candidate's fixed columns nor its
// product_extra_spec rows confirm, this searches that SAME product's own
// published datasheet — now CHUNKED (product_datasheet_chunks, populated by
// chunkDatasheet.js at publish time) — for it, using Postgres's built-in
// full-text search ranked per chunk, not one giant per-product blob. No
// vector DB/embedding model/extension required.
//
// Anti-hallucination contract, same shape as everywhere else in this app:
//   1. Only ever searches the ONE candidate's own datasheet chunks — never
//      other products', never anything outside what Forbes Marshall
//      itself published.
//   2. ts_headline() returns actual excerpted substrings of that chunk, not
//      anything synthesized.
//   3. The LLM step is given ONLY those excerpts and is explicitly told to
//      answer null if they don't state the answer — never to reason from
//      its own trained knowledge of what such a product "usually" has.
//   4. Every value shown to the user is paired with the excerpt it came
//      from and a link back to the actual datasheet PDF (already served
//      at /products/:id/catalogue) — never presented as a bare fact.

const db = require('../config/db');
const { extractStructured } = require('./llmClient');

// ts_rank on a near-total mismatch still returns a nonzero float (e.g.
// 1e-20, not exactly 0) — a small floor, not <= 0, is what actually
// filters out "nothing relevant found."
const RANK_FLOOR = 0.01;

/**
 * @param {string} productId
 * @param {string} question - plain-language description of the missing spec
 * @returns {Promise<{ excerpt: string, rank: number }|null>}
 */
async function searchDatasheet(productId, question) {
  const { rows } = await db.query(
    `SELECT
       chunk_index,
       ts_headline('english', content, plainto_tsquery('english', $2),
         'MaxFragments=2, MinWords=6, MaxWords=40, StartSel=<<, StopSel=>>') AS excerpt,
       ts_rank(to_tsvector('english', content), plainto_tsquery('english', $2)) AS rank
     FROM product_datasheet_chunks
     WHERE product_id = $1
     ORDER BY rank DESC
     LIMIT 3`,
    [productId, question]
  );
  const best = rows.find((r) => Number(r.rank) >= RANK_FLOOR);
  if (best) return { excerpt: best.excerpt, rank: Number(best.rank) };
  if (rows.length > 0) return null; // has chunks, just none relevant — don't fall through

  // No chunks at all for this product yet (published before the chunking
  // pipeline existed, and npm run db:backfill-chunks hasn't been run) —
  // fall back to the old whole-document search so lookups don't silently
  // stop working in the meantime.
  const { rows: legacyRows } = await db.query(
    `SELECT
       ts_headline('english', datasheet_text, plainto_tsquery('english', $2),
         'MaxFragments=3, MinWords=6, MaxWords=40, StartSel=<<, StopSel=>>') AS excerpt,
       ts_rank(to_tsvector('english', coalesce(datasheet_text, '')), plainto_tsquery('english', $2)) AS rank
     FROM products
     WHERE id = $1 AND datasheet_text IS NOT NULL AND datasheet_text != ''`,
    [productId, question]
  );
  if (!legacyRows.length || legacyRows[0].rank < RANK_FLOOR) return null;
  return { excerpt: legacyRows[0].excerpt, rank: Number(legacyRows[0].rank) };
}

const lookupSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'true only if the excerpt explicitly states the answer.' },
    value: { type: ['string', 'null'], description: 'The value as stated in the excerpt, verbatim or near-verbatim. Null if not found.' },
  },
  required: ['found'],
};

const SYSTEM_PROMPT = `You answer a specific technical question using ONLY the datasheet excerpt given to you.
The excerpt may contain <<...>> markers around the most relevant parts — read the whole excerpt regardless.
If the excerpt doesn't state the answer clearly, set found=false and value=null — do NOT guess, infer from general product knowledge, or use anything not present in the excerpt.
If it does state it, quote or closely paraphrase the excerpt's own wording.`;

/**
 * @param {string} productId
 * @param {string} question
 * @returns {Promise<{ found: boolean, value: string|null, source: {productId:string, excerpt:string}|null }>}
 */
async function lookupSpecInDatasheet(productId, question) {
  const hit = await searchDatasheet(productId, question);
  if (!hit) return { found: false, value: null, source: null };

  const userText = `Question: ${question}\n\nDatasheet excerpt:\n${hit.excerpt}`;
  try {
    const { data } = await extractStructured(SYSTEM_PROMPT, userText, lookupSchema);
    if (!data.found || data.value == null) return { found: false, value: null, source: null };
    return { found: true, value: data.value, source: { productId, excerpt: hit.excerpt.replace(/<<|>>/g, '') } };
  } catch (err) {
    console.error('Internal datasheet lookup grounding failed:', err.message);
    return { found: false, value: null, source: null };
  }
}

module.exports = { lookupSpecInDatasheet, searchDatasheet };
