// server/test/parseSpreadsheetTable.test.js
//
// Most enquiries arrive as an Excel RFQ sheet. Reading one is not "parse a
// CSV": real sheets have a merged title row, a two- or three-row header band,
// merged cells, a TOTAL row at the bottom, and accounting-style negatives.
//
// Before this parser existed, SheetJS's default read produced column names
// like __EMPTY_9 and the engineer saw an unusable blob.
//
// The workbooks below are built in memory with the same library the parser
// uses, so these tests need no fixture files and cannot go stale against one.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const { parseSpreadsheetTable, pickKnownFields, normalizeValue } = require('../src/services/parseSpreadsheetTable');

/** Build a .xlsx buffer from an array-of-arrays. */
function workbook(rows, { merges = [], sheetName = 'RFQ' } = {}) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (merges.length) ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('normalizeValue', () => {
  test('accounting negatives become real negatives', () => {
    // "(-500) Mbar" and "(500) Mbar" are both how a vacuum range gets typed.
    // Read as text they sort and compare as positive numbers, so a vacuum
    // requirement silently becomes a pressure one.
    assert.equal(normalizeValue('(500) Mbar'), '-500 Mbar');
    assert.equal(normalizeValue('(-500) Mbar'), '-500 Mbar');
  });

  test('ordinary values pass through, trimmed', () => {
    assert.equal(normalizeValue('  SS316  '), 'SS316');
    assert.equal(normalizeValue(42), '42');
  });

  test('blank cells become null, not the string "undefined"', () => {
    assert.equal(normalizeValue(null), null);
    assert.equal(normalizeValue(undefined), null);
    assert.equal(normalizeValue('   '), null);
  });
});

describe('parseSpreadsheetTable', () => {
  test('reads a simple header + rows sheet into labelled cells', () => {
    const buf = workbook([
      ['Tag No', 'Qty', 'MOC', 'Connection'],
      ['PT-101', 2, 'SS316', '1/2" NPT'],
      ['PT-102', 1, 'SS304', '1" NPT'],
    ]);
    const r = parseSpreadsheetTable(buf);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].cells['Tag No'], 'PT-101');
    assert.equal(r.rows[1].cells['MOC'], 'SS304');
    // The whole point: real labels, not __EMPTY_9.
    assert.equal(Object.keys(r.rows[0].cells).some((k) => k.startsWith('__EMPTY')), false);
  });

  test('a merged title row above the header is not mistaken for the header', () => {
    // "REQUEST FOR QUOTATION — PROJECT X" spanning every column is a title.
    // Treated as a header it makes every column share one name and the sheet
    // is unreadable.
    const buf = workbook([
      ['REQUEST FOR QUOTATION — PROJECT X', null, null],
      ['Tag No', 'Qty', 'MOC'],
      ['PT-101', 2, 'SS316'],
    ], { merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }] });

    const r = parseSpreadsheetTable(buf);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].cells['Tag No'], 'PT-101');
  });

  test('a two-row header band is joined, not truncated to one row', () => {
    // "Process | Design" over "Pressure | Temperature" means the columns are
    // "Process — Pressure" and "Design — Temperature". Taking only one row
    // loses which is which.
    const buf = workbook([
      ['Tag', 'Process', 'Design'],
      [null, 'Pressure', 'Temperature'],
      ['PT-101', '10 kg/cm2', '150 C'],
    ]);
    const r = parseSpreadsheetTable(buf);
    assert.equal(r.rows.length, 1);
    const labels = Object.keys(r.rows[0].cells).join(' | ');
    assert.match(labels, /Pressure/);
    assert.match(labels, /Temperature/);
  });

  test('a TOTAL row at the bottom is dropped, not quoted as a line item', () => {
    // Three columns, not two: a header is only recognised at 3+ label cells,
    // which is deliberate — a two-column sheet is far more often a stray note
    // than a bill of materials, and treating one as a table produces confident
    // nonsense.
    const buf = workbook([
      ['Tag No', 'Qty', 'MOC'],
      ['PT-101', 2, 'SS316'],
      ['PT-102', 3, 'SS304'],
      ['TOTAL', 5, null],
    ]);
    const r = parseSpreadsheetTable(buf);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows.some((row) => String(row.cells['Tag No']).toUpperCase() === 'TOTAL'), false);
  });

  test('a workbook with a cover sheet first still finds the RFQ table', () => {
    const ws1 = XLSX.utils.aoa_to_sheet([['Revision history'], ['Rev 0', 'issued']]);
    const ws2 = XLSX.utils.aoa_to_sheet([
      ['Tag No', 'Qty', 'MOC'],
      ['PT-101', 2, 'SS316'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Cover');
    XLSX.utils.book_append_sheet(wb, ws2, 'RFQ');
    const r = parseSpreadsheetTable(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    assert.equal(r.rows[0].cells['Tag No'], 'PT-101');
  });

  test('a sheet with no readable table reports what it saw instead of failing silently', () => {
    // "No readable rows" tells nobody anything. The engineer needs to know
    // whether the file was empty, a scan, or shaped unexpectedly — so this
    // returns a populated `diagnostic` rather than throwing, and the caller
    // surfaces it.
    const r = parseSpreadsheetTable(workbook([[], [], []]));
    assert.deepEqual(r.rows, []);
    assert.ok(r.diagnostic, 'no diagnostic was produced for an unreadable sheet');
    assert.match(r.diagnostic, /Sheets found/);
    assert.ok(r.diagnostic.length > 40, `unhelpful diagnostic: ${r.diagnostic}`);
  });
});

describe('pickKnownFields', () => {
  test('finds tag, quantity, material and connection under varied labels', () => {
    assert.deepEqual(
      pickKnownFields({ 'Tag No': 'PT-101', 'Qty (Nos)': '2', 'MOC': 'SS316', 'Process Connection': '1/2" NPT' }),
      { tagNo: 'PT-101', qty: 2, moc: 'SS316', connection: '1/2" NPT' }
    );
  });

  test('ignores an "Old Tag" column', () => {
    // Revamp enquiries carry the tag being replaced next to the new one.
    // Quoting against the old tag quotes the wrong instrument.
    const r = pickKnownFields({ 'Old Tag No': 'PT-001', 'Tag No': 'PT-101' });
    assert.equal(r.tagNo, 'PT-101');
  });

  test('a non-numeric quantity is left null rather than becoming NaN', () => {
    // NaN would flow into the offer and print as "NaN nos".
    assert.equal(pickKnownFields({ Qty: 'as required' }).qty, null);
  });

  test('missing columns are null, not undefined or empty string', () => {
    assert.deepEqual(pickKnownFields({}), { tagNo: null, qty: null, moc: null, connection: null });
  });
});
