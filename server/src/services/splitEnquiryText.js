// server/src/services/splitEnquiryText.js
//
// One uploaded file / one pasted message can describe more than one
// instrument. This splits raw enquiry text into independent enquiry blocks
// BEFORE matching runs, so each block gets its own category detection, its
// own candidate set, and its own match card — instead of one enquiry with a
// jumbled combined requirement.
//
// Three splitting strategies, tried in order (first one that fires wins):
//   1. Numbered/labelled items — "1.", "2)", "Enquiry 2:", "Item 3 -" etc.
//   2. Table-like rows — several consecutive lines that each look like a
//      row of columns (tab-separated, or 2+ runs of multiple spaces), which
//      is how a pasted spreadsheet selection usually looks as plain text.
//   3. Blank-line-separated paragraphs — falls back to this when neither of
//      the above applies but the text clearly has more than one paragraph.
// If nothing suggests more than one enquiry, the whole text comes back as a
// single block — this must never split a single enquiry that just happens
// to be multi-line.

const MAX_BLOCKS = 20;
const MIN_BLOCK_LENGTH = 8; // ignore stray short fragments (e.g. a trailing blank item)

const NUMBERED_ITEM_RE = /^[ \t]*(?:(?:enquiry|item|product|line)\s*#?\s*\d+\s*[:.\-)]|\d{1,2}[.)])\s+/im;

function splitOnNumbering(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((line, i) => {
    if (NUMBERED_ITEM_RE.test(line)) starts.push(i);
  });
  // Need at least 2 numbered markers to justify treating this as multiple
  // enquiries rather than one enquiry that happens to mention "1/2 NPT" etc.
  if (starts.length < 2) return null;

  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : lines.length;
    const raw = lines.slice(from, to).join('\n');
    // Strip the leading marker itself so the matcher sees the requirement
    // text, not "2." or "Enquiry 2:" as the first token.
    const cleaned = raw.replace(NUMBERED_ITEM_RE, '').trim();
    if (cleaned.length >= MIN_BLOCK_LENGTH) blocks.push(cleaned);
  }
  return blocks.length >= 2 ? blocks : null;
}

// A "row" is a line with 2+ column separators (tab, or 2+ spaces acting as a
// column gap when text is pasted from a spreadsheet/table).
const ROW_SPLIT_RE = /\t+|[ ]{2,}/;

function splitOnTableRows(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = lines.filter((l) => l.split(ROW_SPLIT_RE).length >= 3);
  // Require most non-empty lines to look like table rows, not just one or
  // two — otherwise this misfires on a normal paragraph that happens to
  // have wide spacing somewhere.
  if (rows.length < 2 || rows.length < lines.length * 0.6) return null;

  return rows
    .map((row) => row.split(ROW_SPLIT_RE).map((c) => c.trim()).filter(Boolean).join(', '))
    .filter((block) => block.length >= MIN_BLOCK_LENGTH);
}

function splitOnBlankLines(text) {
  const blocks = text
    .split(/\r?\n\s*\r?\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length >= MIN_BLOCK_LENGTH);
  return blocks.length >= 2 ? blocks : null;
}

/**
 * @param {string} text - raw enquiry text (typed or extracted from an upload)
 * @returns {string[]} one or more independent enquiry text blocks, in order
 */
function splitEnquiryText(text) {
  if (!text || !text.trim()) return [text || ''];

  const byNumbering = splitOnNumbering(text);
  if (byNumbering) return byNumbering.slice(0, MAX_BLOCKS);

  const byTable = splitOnTableRows(text);
  if (byTable) return byTable.slice(0, MAX_BLOCKS);

  const byBlankLines = splitOnBlankLines(text);
  if (byBlankLines) return byBlankLines.slice(0, MAX_BLOCKS);

  return [text.trim()];
}

module.exports = { splitEnquiryText };