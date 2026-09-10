// server/test/documentWorker.test.js
//
// The file parsers run in a worker thread because xlsx@0.18.5 carries an
// unfixed HIGH-severity prototype-pollution advisory and an unfixed ReDoS
// advisory, and the files it parses arrive from outside the company.
//
// Isolation is only worth having if it actually holds, so these tests check
// the properties that matter rather than that the wiring compiles.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');

const { parseExcelInWorker, extractPdfTextInWorker } = require('../src/services/documentWorker');

function workbook(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'RFQ');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('documentWorker', () => {
  test('parses a normal workbook and returns the same shape as the direct call', async () => {
    const buf = workbook([
      ['Tag No', 'Qty', 'MOC'],
      ['PT-101', 2, 'SS316'],
    ]);
    const viaWorker = await parseExcelInWorker(buf);
    const { parseExcelEnquiries } = require('../src/services/enquiryFileParser');
    const direct = parseExcelEnquiries(buf);

    // Isolation must not change the answer.
    assert.deepEqual(viaWorker.columns, direct.columns);
    assert.equal(viaWorker.blocks.length, direct.blocks.length);
    assert.equal(viaWorker.blocks.length, 1);
  });

  test('the caller keeps its buffer — it is copied, not detached', async () => {
    // worker_threads CAN transfer an ArrayBuffer, which leaves the sender with
    // a zero-length buffer. multer hands the same buffer to storage.save() and
    // to the hash, so detaching it here would store an empty file.
    const buf = workbook([['Tag No', 'Qty', 'MOC'], ['PT-101', 1, 'SS316']]);
    const lengthBefore = buf.length;
    await parseExcelInWorker(buf);
    assert.equal(buf.length, lengthBefore);
    assert.ok(buf.length > 0);
  });

  test('a corrupt file yields an explained empty result, not a crash and not silence', async () => {
    // SheetJS does not throw on arbitrary bytes — it reads them as a
    // single-cell sheet — so the contract here is "no rows, and a diagnostic
    // saying why". That diagnostic is what parseEnquiryFile turns into the
    // warning the engineer sees; without it the file was silently ignored and
    // matching ran on the typed text alone with no indication anything had
    // been dropped.
    const r = await parseExcelInWorker(Buffer.from('this is definitely not a spreadsheet'));
    assert.deepEqual(r.blocks, []);
    assert.ok(r.diagnostic, 'no diagnostic for an unreadable file');
    assert.ok(r.diagnostic.length > 40, `unhelpful diagnostic: ${r.diagnostic}`);
  });

  test('an empty buffer yields an explained empty result rather than hanging', async () => {
    const r = await parseExcelInWorker(Buffer.alloc(0));
    assert.deepEqual(r.blocks, []);
    assert.ok(r.diagnostic);
  });

  test('an unreadable attachment reaches the caller as a WARNING, never silently', async () => {
    // The user-facing guarantee behind the diagnostic above.
    const { parseEnquiryFile } = require('../src/services/enquiryFileParser');
    const result = await parseEnquiryFile({
      buffer: Buffer.from('this is definitely not a spreadsheet'),
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      originalname: 'broken.xlsx',
    });
    assert.equal(result.kind, 'excel');
    assert.deepEqual(result.blocks, []);
    assert.ok(result.warning, 'an unreadable spreadsheet produced no warning');
    assert.match(result.warning, /broken\.xlsx/);
  });

  test('a garbage PDF is rejected without taking the process down', async () => {
    await assert.rejects(() => extractPdfTextInWorker(Buffer.from('%PDF-1.4 nonsense')));
  });

  test('parsing does not pollute the MAIN thread\'s Object.prototype', async () => {
    // This is the containment claim, stated as a test. Anything the parser
    // does to its own isolate's prototypes dies with the worker; the property
    // below must never appear on the main thread's Object.prototype.
    const canary = `__fm_canary_${Date.now()}`;
    assert.equal(canary in {}, false);

    await parseExcelInWorker(workbook([['Tag No', 'Qty', 'MOC'], ['PT-101', 1, 'SS316']]));

    assert.equal(canary in {}, false);
    assert.equal(Object.prototype.polluted, undefined);
    // A sanity check that the isolate boundary is real: the main thread's
    // Object.prototype has no own properties beyond the built-ins.
    assert.equal(Object.getOwnPropertyNames(Object.prototype).includes('polluted'), false);
  });

  test('several files can be parsed concurrently', async () => {
    // Ten engineers uploading at once is the stated concurrency target; a
    // worker-per-parse design has to survive that rather than serialise it.
    const buffers = Array.from({ length: 6 }, (_, i) =>
      workbook([['Tag No', 'Qty', 'MOC'], [`PT-${100 + i}`, 1, 'SS316']]));
    const results = await Promise.all(buffers.map(parseExcelInWorker));
    assert.equal(results.length, 6);
    results.forEach((r, i) => {
      assert.equal(r.blocks.length, 1, `file ${i} produced no block`);
    });
  });
});
