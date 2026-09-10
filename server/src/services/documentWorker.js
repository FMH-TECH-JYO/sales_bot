// server/src/services/documentWorker.js
//
// Runs the two file parsers — Excel and PDF — inside a worker thread with a
// hard timeout, instead of on the server's event loop.
//
// This is the mitigation for three separate findings that share one cause:
// the app parses files that arrive from outside the company, on the same
// thread that serves every other request.
//
//   1. xlsx (SheetJS) 0.18.5 carries a HIGH-severity prototype-pollution
//      advisory (GHSA-4r6h-8v6p-xvw6) with NO FIX AVAILABLE on npm — the
//      patched 0.20.x releases are published only to the vendor's own CDN.
//      Parsing in a worker means any pollution lands in the worker's isolate,
//      which is destroyed when the parse ends. The main process's
//      Object.prototype is never in reach.
//   2. The same package carries a ReDoS advisory (GHSA-5pgg-2g8v-p4x9), also
//      unfixed on npm. A crafted sheet that sends a regex exponential burns a
//      worker thread for TIMEOUT_MS and is then killed, rather than freezing
//      the whole server for as long as it takes.
//   3. pdf-parse is synchronous and CPU-heavy. A large scanned PDF used to
//      stall every concurrent request; with ten engineers sharing one process
//      that is the difference between "slow" and "down".
//
// This does NOT make xlsx@0.18.5 safe, and it is not a substitute for
// upgrading. When the vendor's build is reachable from your network:
//     npm install --workspace=server https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
// Until then the containment above is what stands between a hostile RFQ and
// the process. DEPLOY.md records this as an accepted, mitigated risk.

const path = require('path');
const { Worker } = require('worker_threads');

// Long enough for a genuinely large workbook (the reference RFQ parses in
// milliseconds; a 5 MB multi-sheet file in a second or two), short enough that
// a wedged parse does not tie up memory for minutes.
const TIMEOUT_MS = Number(process.env.DOCUMENT_PARSE_TIMEOUT_MS) || 30_000;

const WORKER_FILE = path.join(__dirname, 'documentWorkerEntry.js');

/**
 * @param {'excel'|'pdf'} task
 * @param {Buffer} buffer
 * @returns {Promise<any>} whatever the underlying parser returns
 */
function runParse(task, buffer) {
  return new Promise((resolve, reject) => {
    // A copy is passed rather than a transfer: the caller still owns its
    // buffer (multer's memory storage hands the same object to other code),
    // and detaching it here would produce a zero-length buffer downstream.
    const worker = new Worker(WORKER_FILE, { workerData: { task, buffer } });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});   // already exiting in the happy path
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(reject, Object.assign(
        new Error(
          `Reading this file took longer than ${Math.round(TIMEOUT_MS / 1000)} seconds and was stopped. ` +
          'It may be corrupt, extremely large, or crafted to be slow to parse.'
        ),
        { status: 422, code: 'PARSE_TIMEOUT' }
      ));
    }, TIMEOUT_MS);
    timer.unref();

    worker.on('message', (msg) => {
      if (msg && msg.ok) return finish(resolve, msg.value);
      // Errors do not survive structuredClone with their prototype intact, so
      // the worker sends the parts that matter and they are rebuilt here.
      const err = new Error((msg && msg.error) || 'The file could not be read.');
      err.status = (msg && msg.status) || 422;
      finish(reject, err);
    });

    worker.on('error', (err) => finish(reject, err));

    worker.on('exit', (code) => {
      if (settled) return;
      finish(reject, new Error(`The file reader stopped unexpectedly (exit code ${code}).`));
    });
  });
}

const parseExcelInWorker = (buffer) => runParse('excel', buffer);
const extractPdfTextInWorker = (buffer) => runParse('pdf', buffer);

module.exports = { parseExcelInWorker, extractPdfTextInWorker, TIMEOUT_MS };
