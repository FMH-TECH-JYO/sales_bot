// server/src/services/chunkDatasheet.js
//
// Classical text chunking — no LLM involved, deterministic and fast, same
// "classical text processing for deterministic parts" philosophy as the
// rest of this codebase. Splits a datasheet's parsed text into overlapping,
// section-aware chunks so the internal RAG retrieval in
// internalDatasheetLookup.js can search and rank individual passages
// instead of running full-text search over one giant blob per product.
//
// Strategy: split on blank-line paragraph/section boundaries first (PDFs
// extracted via pdf-parse naturally keep these), then pack paragraphs into
// chunks up to maxChars. A paragraph that alone exceeds maxChars (e.g. a
// dense range table with no blank lines) is hard-split with overlap so no
// single chunk becomes unsearchably large. Overlap on hard splits only —
// paragraph-packed chunks don't need it since paragraphs are never cut mid
// sentence there.

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;

/**
 * @param {string} text - full parsed datasheet text
 * @param {{maxChars?: number, overlapChars?: number}} [opts]
 * @returns {string[]} ordered chunk strings, ready to store one-per-row
 */
function chunkText(text, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  if (!text || !text.trim()) return [];

  const normalized = text.replace(/\r\n/g, '\n').trim();
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks = [];
  let current = '';

  function flush() {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  }

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // A single paragraph too big to fit in one chunk (e.g. an unbroken
      // range/order-code table) — flush what we have, then hard-split this
      // paragraph on its own with overlap so context isn't lost at the cut.
      flush();
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + maxChars, para.length);
        chunks.push(para.slice(start, end).trim());
        if (end === para.length) break;
        start = end - overlapChars;
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > maxChars) {
      flush();
      current = para;
    } else {
      current = candidate;
    }
  }
  flush();

  return chunks.filter(Boolean);
}

module.exports = { chunkText, DEFAULT_MAX_CHARS, DEFAULT_OVERLAP_CHARS };
