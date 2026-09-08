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

const XLSX = require('xlsx');
const { extractText: extractPdfText } = require('./pdfParser');

const ID_COLUMN_RE = /^(s\.?\s?no\.?|sr\.?\s?no\.?|item\s?no\.?|enq(uiry)?\s?no\.?|line\s?no\.?|#)$/i;
const PRODUCT_COLUMN_RE = /^(product|item|description|equipment|instrument|requirement|particulars|specification)/i;

function cellsToText(row) {
  return Object.entries(row)
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${String(v).trim()}`)
    .join('\n');
}

function isBlankRow(row) {
  return Object.values(row).every((v) => v === null || v === undefined || String(v).trim() === '');
}

/**
 * @param {Buffer} buffer
 * @returns {{ blocks: Array<{ text: string, rowRange: string, rows: object[] }>, sheetName: string, columns: string[] }}
 */
function parseExcelEnquiries(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find((n) => {
    const sheet = wb.Sheets[n];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    return rows.length > 0;
  }) || wb.SheetNames[0];

  const sheet = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false })
    .map((r) => {
      const cleaned = {};
      for (const [k, v] of Object.entries(r)) {
        const key = String(k).trim();
        cleaned[key] = v;
      }
      return cleaned;
    })
    .filter((r) => !isBlankRow(r));

  if (rawRows.length === 0) {
    return { blocks: [], sheetName, columns: [] };
  }

  const columns = Object.keys(rawRows[0]);
  const idColumn = columns.find((c) => ID_COLUMN_RE.test(c));
  const productColumn = columns.find((c) => PRODUCT_COLUMN_RE.test(c));

  const groups = [];
  let current = null;
  let lastIdValue = undefined;

  rawRows.forEach((row, i) => {
    const excelRowNo = i + 2; // +1 for 0-index, +1 for header row
    if (idColumn) {
      const idVal = row[idColumn] != null ? String(row[idColumn]).trim() : '';
      const startsNew = idVal !== '' && idVal !== lastIdValue;
      if (startsNew || !current) {
        current = { rows: [row], startRow: excelRowNo, endRow: excelRowNo };
        groups.push(current);
        if (idVal !== '') lastIdValue = idVal;
      } else {
        current.rows.push(row);
        current.endRow = excelRowNo;
      }
    } else if (productColumn) {
      const productVal = row[productColumn] != null ? String(row[productColumn]).trim() : '';
      const startsNew = productVal !== '' || !current;
      if (startsNew) {
        current = { rows: [row], startRow: excelRowNo, endRow: excelRowNo };
        groups.push(current);
      } else {
        current.rows.push(row);
        current.endRow = excelRowNo;
      }
    } else {
      // No recognizable grouping column — one row is one enquiry.
      current = { rows: [row], startRow: excelRowNo, endRow: excelRowNo };
      groups.push(current);
    }
  });

  const blocks = groups.map((g) => ({
    text: g.rows.map(cellsToText).join('\n---\n'),
    rowRange: g.startRow === g.endRow ? `row ${g.startRow}` : `rows ${g.startRow}-${g.endRow}`,
    rows: g.rows,
  })).filter((b) => b.text.trim() !== '');

  return { blocks, sheetName, columns };
}

const EXCEL_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
]);

function isExcelMime(mimetype) {
  return EXCEL_MIME_TYPES.has(mimetype);
}
function isPdfMime(mimetype) {
  return mimetype === 'application/pdf';
}

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
  if (isExcelMime(file.mimetype)) {
    const { blocks, sheetName, columns } = parseExcelEnquiries(file.buffer);
    if (blocks.length === 0) {
      return { kind: 'excel', blocks: [], warning: `"${file.originalname}" (sheet "${sheetName}") had no readable rows.` };
    }
    return { kind: 'excel', blocks, sheetName, columns };
  }
  if (isPdfMime(file.mimetype)) {
    const { text, quality } = await extractPdfText(file.buffer);
    if (quality === 'likely_scanned') {
      return { kind: 'pdf', text, warning: `"${file.originalname}" looks scanned/image-based — little or no text could be extracted. OCR isn't supported yet.` };
    }
    return { kind: 'pdf', text };
  }
  throw new Error(`Unsupported enquiry file type "${file.mimetype}" — only PDF and Excel (.xlsx/.xls) are accepted.`);
}

module.exports = { parseEnquiryFile, parseExcelEnquiries, isExcelMime, isPdfMime };
