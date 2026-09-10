// server/src/services/enquiryFileParser.js
//
// Turns an uploaded enquiry FILE (Excel or PDF) into one or more raw text
// "blocks" — one block per distinct product enquiry — before anything gets
// anywhere near the LLM. This is the classical/deterministic half of the
// split, same philosophy as parseEnquiryText.js / preprocess.js: grouping
// spreadsheet rows into logical items is exact, rule-based work; only the
// genuinely ambiguous prose case (a PDF/typed paragraph) is handed to
// splitEnquiries.js's LLM-assisted pass.
//
// Excel grouping heuristic ("detect blocks/groups intelligently", not a
// rigid one-row-per-enquiry rule):
//   1. Read the first non-empty sheet as an array of header-keyed row
//      objects (row 1 = headers).
//   2. If a column looks like an item/serial/enquiry identifier (header
//      matches /^(s\.?\s?no\.?|sr\.?\s?no\.?|item\s?no\.?|enq(uiry)?\s?no\.?|line\s?no\.?|#)$/i),
//      group consecutive rows by that value — rows sharing a value, or
//      rows with that cell blank, belong to the previous group (common
//      pattern for "one enquiry, multiple accessory lines").
//   3. Otherwise, group by the first column that looks like a product/
//      description field: a NEW group starts whenever that cell is
//      non-empty; blank-in-that-column rows are folded into the current
//      group as extra spec lines (again, the "accessory row" pattern).
//   4. If neither heuristic finds a usable column (e.g. every row is fully
//      populated with no distinguishing key), fall back to one row = one
//      block, which is the common case for a flat "list of enquiries"
//      sheet.
// Every block keeps its original row range so the UI/audit trail can point
// back to exactly which spreadsheet rows produced which match result.

// Nothing here reads the workbook directly any more: header/table detection
// moved to parseSpreadsheetTable.js. The XLSX import, the ID/PRODUCT column
// regexes and the cellsToText/isBlankRow helpers that went with the old
// sheet_to_json approach were left behind by that move and are removed here —
// dead code that still looks authoritative is worse than no code, because the
// next person to touch this file has to work out which of the two column
// detectors is the live one.
const { parseSpreadsheetTable, pickKnownFields } = require('./parseSpreadsheetTable');

/**
 * @param {Buffer} buffer
 * @returns {{ blocks: Array<{ text: string, rowRange: string, rows: object[] }>, sheetName: string, columns: string[] }}
 */
function parseExcelEnquiries(buffer) {
  // Header/table detection lives in parseSpreadsheetTable.js. The old code here
  // called XLSX.utils.sheet_to_json(sheet), which assumes row 1 is the header —
  // on a real RFQ (merged title banner, two-row header) that produced columns
  // named __EMPTY_9 and emitted the header rows themselves as product
  // enquiries. See that file's header comment for the worked example.
  const table = parseSpreadsheetTable(buffer);
  if (!table.rows.length) {
    return { blocks: [], sheetName: table.sheetName, columns: table.columns, title: table.title, diagnostic: table.diagnostic };
  }

  // Group consecutive rows that share an identifier (tag / serial), so an item
  // described across several rows stays one enquiry. Rows with distinct tags —
  // the common case — become one block each.
  const groups = [];
  let current = null;
  let lastId;
  for (const row of table.rows) {
    const known = pickKnownFields(row.cells);
    const id = known.tagNo || null;
    if (!current || (id && id !== lastId)) {
      current = { rows: [row], known, startRow: row.excelRow, endRow: row.excelRow };
      groups.push(current);
      if (id) lastId = id;
    } else {
      current.rows.push(row);
      current.endRow = row.excelRow;
    }
  }

  const blocks = groups.map((g) => ({
    text: g.rows.map((r) => r.text).join('\n---\n'),
    rowRange: g.startRow === g.endRow ? `row ${g.startRow}` : `rows ${g.startRow}-${g.endRow}`,
    rows: g.rows.map((r) => r.cells),
    // Read straight off labelled columns — exact, instant, and no LLM call.
    known: g.known,
  })).filter((b) => b.text.trim() !== '');

  return { blocks, sheetName: table.sheetName, columns: table.columns, title: table.title };
}

const EXCEL_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
]);

// MIME first, filename second. See the note in middleware/uploadEnquiryFile.js:
// a real .xlsx routinely arrives as application/octet-stream, and deciding on
// MIME alone meant matchEnquiry.js took its "not a supported file" branch and
// dropped the attachment without a word.
function isExcelFile(file) {
  if (EXCEL_MIME_TYPES.has(file?.mimetype)) return true;
  return /\.(xlsx|xls|xlsm)$/i.test(file?.originalname || '');
}
function isPdfFile(file) {
  if (file?.mimetype === 'application/pdf') return true;
  return /\.pdf$/i.test(file?.originalname || '');
}
// Kept for callers that only have a MIME string.
function isExcelMime(mimetype) { return EXCEL_MIME_TYPES.has(mimetype); }
function isPdfMime(mimetype) { return mimetype === 'application/pdf'; }

/**
 * Normalizes ANY supported enquiry attachment (Excel or PDF) down to either
 * a set of pre-grouped text blocks (Excel — grouping already done, exact)
 * or a single raw text blob (PDF — grouping still needs splitEnquiries.js's
 * LLM-assisted pass, since a datasheet/RFQ letter's structure isn't a grid).
 *
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 * @returns {Promise<{ kind: 'excel'|'pdf', blocks?: object[], text?: string, warning?: string }>}
 */
async function parseEnquiryFile(file) {
  if (isExcelFile(file)) {
    // Parsed in a worker thread, not here. The xlsx package has an unfixed
    // high-severity prototype-pollution advisory and an unfixed ReDoS
    // advisory, and this buffer came from outside the company. See
    // documentWorker.js for what the isolation does and does not buy.
    const { parseExcelInWorker } = require('./documentWorker');
    const { blocks, sheetName, columns, title, diagnostic } = await parseExcelInWorker(file.buffer);
    if (blocks.length === 0) {
      return {
        kind: 'excel',
        blocks: [],
        warning: `Nothing could be read from "${file.originalname}"` +
          (sheetName ? ` (sheet "${sheetName}")` : '') + '. ' +
          (diagnostic || 'No header row followed by data rows was found.') +
          ' Matching used only the text you typed.',
      };
    }
    return { kind: 'excel', blocks, sheetName, columns, title };
  }
  if (isPdfFile(file)) {
    // Also off the event loop: pdf-parse is synchronous and CPU-heavy, so a
    // large scan used to stall every other request for its duration.
    const { extractPdfTextInWorker } = require('./documentWorker');
    const { text, quality } = await extractPdfTextInWorker(file.buffer);
    if (quality === 'likely_scanned') {
      return { kind: 'pdf', text, warning: `"${file.originalname}" looks scanned/image-based — little or no text could be extracted. OCR isn't supported yet.` };
    }
    return { kind: 'pdf', text };
  }
  throw new Error(`Can't read "${file.originalname}" (type "${file.mimetype || 'unknown'}") — only PDF and Excel (.xlsx/.xls) content is parsed.`);
}

module.exports = {
  isExcelFile,
  isPdfFile, parseEnquiryFile, parseExcelEnquiries, isExcelMime, isPdfMime };
