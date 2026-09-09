// server/src/services/parseSpreadsheetTable.js
//
// Turns a real customer RFQ spreadsheet into labelled rows.
//
// WHY THIS EXISTS
// ---------------
// enquiryFileParser.js used XLSX.utils.sheet_to_json(sheet), which assumes
// "row 1 = headers". Real RFQs do not look like that. Running the actual
// P19 NTEPL pressure-transmitter enquiry through the old path produced:
//
//   __EMPTY_3: N2+ACETONE
//   __EMPTY_9: (-500) Mbar
//   __EMPTY_12: 0
//
// ...because row 1 was a merged TITLE ("P19 - NTEPL TECHNICAL EQUIPMENT
// DETAILS"), so every column got named __EMPTY_n. The real header was spread
// over rows 2 AND 3 with merged group cells, and those two header rows were
// then emitted as if they were two more product enquiries. 15 "enquiries" came
// out of a sheet containing 10.
//
// The LLM was being asked to match `__EMPTY_9: (-500) Mbar` with no idea that
// it meant "minimum pressure" — and `__EMPTY_12: 0` (a TEMPERATURE) looks
// identical in form to a pressure. No larger model fixes an unlabelled column;
// this is a parsing problem, and it is the single biggest accuracy win
// available in the pipeline.
//
// WHAT IT HANDLES
//   * title rows above the real header
//   * multi-row headers, joined top-to-bottom ("PRESSURE IN KG/CM2 — MIN")
//   * merged group headers, expanded across the columns they span
//   * blank rows between header and data
//   * footer/total rows ("TOTAL : QTY", "UNIT  NOS")
//   * entirely empty columns, dropped
//   * accounting negatives: "(-500) Mbar" -> "-500 Mbar"

const XLSX = require('xlsx');

const TOTAL_ROW_RE = /^\s*(total|grand\s*total|sub\s*total|unit)\b/i;
const NUMERIC_RE = /^\(?-?[\d,]+(\.\d+)?\)?\s*[a-zA-Z%°/"']*\.?$/;

/** "(-500) Mbar" and "(500)" are accounting negatives; make them real ones. */
function normalizeValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^\((-?[\d.,]+)\)\s*(.*)$/);
  if (m) {
    const num = m[1].startsWith('-') ? m[1] : `-${m[1]}`;
    return `${num}${m[2] ? ' ' + m[2] : ''}`.trim();
  }
  return s;
}

function nonEmptyCount(row) {
  return row.reduce((n, c) => n + (c !== null && c !== undefined && String(c).trim() !== '' ? 1 : 0), 0);
}

function looksNumeric(v) {
  return v !== null && NUMERIC_RE.test(String(v).trim());
}

/** Fraction of populated cells that read as numbers/measurements. */
function numericFraction(row) {
  const filled = row.filter((c) => c !== null && String(c).trim() !== '');
  if (!filled.length) return 0;
  return filled.filter(looksNumeric).length / filled.length;
}

/**
 * Read a sheet as a raw grid, with merged cells expanded so a group header
 * covers every column it spans.
 */
function toGrid(sheet) {
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false, blankrows: true });
  for (const m of sheet['!merges'] || []) {
    const value = grid[m.s.r] ? grid[m.s.r][m.s.c] : null;
    if (value === null || value === undefined) continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      if (!grid[r]) grid[r] = [];
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (grid[r][c] === null || grid[r][c] === undefined) grid[r][c] = value;
      }
    }
  }
  const width = grid.reduce((w, r) => Math.max(w, r ? r.length : 0), 0);
  return grid.map((r) => {
    const row = new Array(width).fill(null);
    (r || []).forEach((v, i) => { row[i] = normalizeValue(v); });
    return row;
  });
}

/**
 * Find the header band: the run of consecutive label-ish rows immediately
 * before the data starts. Title rows (one or two populated cells) are skipped.
 */
function isTitleRow(row) {
  // A merged banner ("P19 - NTEPL TECHNICAL EQUIPMENT DETAILS" across B1:E1)
  // looks populated once merges are expanded, but every populated cell holds
  // the SAME value. A real header row has distinct labels per column.
  const filled = row.filter((c) => c !== null && String(c).trim() !== '');
  return filled.length > 0 && new Set(filled.map((c) => String(c).trim())).size <= 1;
}

/** The banner text above the table — usually the customer's project reference. */
function findTitle(grid, headerStart) {
  for (let i = 0; i < headerStart; i++) {
    const filled = (grid[i] || []).filter((c) => c !== null && String(c).trim() !== '');
    if (filled.length) return String(filled[0]).trim();
  }
  return null;
}

function findHeaderBand(grid) {
  let best = null;
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const count = nonEmptyCount(grid[i]);
    if (count < 3) continue;                        // spacer
    if (isTitleRow(grid[i])) continue;              // merged banner, not a header
    if (numericFraction(grid[i]) > 0.3) break;      // already into data
    if (best === null) best = { start: i, end: i };
    else if (i === best.end + 1) best.end = i;      // second header row
    else break;
  }
  return best;
}

/** Join header rows top-to-bottom per column, de-duplicating repeats. */
function buildColumnLabels(grid, band, width) {
  const labels = [];
  for (let c = 0; c < width; c++) {
    const parts = [];
    for (let r = band.start; r <= band.end; r++) {
      const v = grid[r] ? grid[r][c] : null;
      if (v === null || String(v).trim() === '') continue;
      const t = String(v).trim().replace(/\s+/g, ' ');
      if (parts[parts.length - 1] !== t) parts.push(t);
    }
    labels[c] = parts.join(' — ');
  }
  return labels;
}

/**
 * @param {Buffer} buffer   xlsx/xls file bytes
 * @returns {{sheetName: string, columns: string[], rows: Array<{excelRow: number, cells: Object, text: string}>,
 *            headerRange: string|null, droppedFooterRows: number}}
 */
function parseSpreadsheetTable(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  // Pick the first sheet that actually has a usable table, not just the first
  // sheet — RFQ workbooks often lead with a cover or revision-history tab.
  let chosen = null;
  for (const name of wb.SheetNames) {
    const grid = toGrid(wb.Sheets[name]);
    const band = findHeaderBand(grid);
    if (band && grid.length > band.end + 1) { chosen = { name, grid, band }; break; }
  }
  if (!chosen) {
    // Say what was actually seen. "No readable rows" tells nobody anything;
    // "3 sheets, 40 rows scanned, no row had 3+ label-like cells" tells the
    // admin the header is somewhere unexpected.
    const name = wb.SheetNames[0];
    const scanned = toGrid(wb.Sheets[name]);
    const populated = scanned.filter((r) => nonEmptyCount(r) > 0).length;
    return {
      sheetName: name,
      title: null,
      columns: [],
      rows: [],
      headerRange: null,
      droppedFooterRows: 0,
      diagnostic: `Sheets found: ${wb.SheetNames.join(', ')}. ` +
        `${populated} non-empty row(s) in "${name}", but no row looked like a column header ` +
        `(a header needs 3+ label cells that aren't numbers).`,
    };
  }

  const { name: sheetName, grid, band } = chosen;
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const labels = buildColumnLabels(grid, band, width);
  const headerWidth = nonEmptyCount(labels);
  // A data row must be reasonably populated. Footer lines like
  // "UNIT | NOS" or "TOTAL : QTY | 10" have two cells and would otherwise be
  // matched as if they were products.
  const minCells = Math.max(3, Math.ceil(headerWidth * 0.25));

  const rows = [];
  let droppedFooterRows = 0;
  for (let r = band.end + 1; r < grid.length; r++) {
    const row = grid[r];
    const count = nonEmptyCount(row);
    if (count === 0) continue;                                   // spacer
    if (row.some((c) => c !== null && TOTAL_ROW_RE.test(String(c)))) { droppedFooterRows++; break; }
    if (count < minCells) { droppedFooterRows++; continue; }

    const cells = {};
    const lines = [];
    for (let c = 0; c < width; c++) {
      const v = row[c];
      if (v === null || String(v).trim() === '') continue;
      const label = labels[c] || `Column ${XLSX.utils.encode_col(c)}`;
      cells[label] = String(v).trim();
      lines.push(`${label}: ${String(v).trim()}`);
    }
    if (!lines.length) continue;
    rows.push({ excelRow: r + 1, cells, text: lines.join('\n') });
  }

  const columns = labels.filter((l) => l && l.trim() !== '');
  const diagnostic = rows.length === 0
    ? `Header found at ${`rows ${band.start + 1}-${band.end + 1}`}, but no row below it had at least ${minCells} filled cells.`
    : null;
  return {
    diagnostic,
    sheetName,
    title: findTitle(grid, band.start),
    columns,
    rows,
    headerRange: `rows ${band.start + 1}-${band.end + 1}`,
    droppedFooterRows,
  };
}

/**
 * Deterministic field pulls. Anything we can read straight off a labelled
 * column should never cost an LLM call — it is faster, free and exact.
 * Tag numbers matter especially: in the P19 sheet the tag prefix itself
 * carries the product type (PT = pressure transmitter, DPT = DIFFERENTIAL
 * pressure transmitter), which is a strong matching signal.
 */
function pickKnownFields(cells) {
  const out = { tagNo: null, qty: null, moc: null, connection: null };
  for (const [label, value] of Object.entries(cells)) {
    const l = label.toLowerCase();
    if (!out.tagNo && /\btag\b/.test(l) && !/old/.test(l)) out.tagNo = value;
    if (!out.qty && /\b(qty|quantity|nos)\b/.test(l)) {
      const n = parseInt(String(value).replace(/[^\d-]/g, ''), 10);
      if (!Number.isNaN(n)) out.qty = n;
    }
    if (!out.moc && /\b(moc|material of construction|wetted)\b/.test(l)) out.moc = value;
    if (!out.connection && /\b(connection|conn|line\s*—?\s*size|size)\b/.test(l)) out.connection = value;
  }
  return out;
}

module.exports = { parseSpreadsheetTable, pickKnownFields, normalizeValue };
