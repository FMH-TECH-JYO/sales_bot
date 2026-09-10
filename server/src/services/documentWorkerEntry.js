// server/src/services/documentWorkerEntry.js
//
// The body of the worker thread started by documentWorker.js. It parses ONE
// file and exits.
//
// Keep this file boring. Everything it requires is loaded inside a thread that
// is about to process untrusted bytes, so it deliberately does not touch the
// database, the filesystem, or the network — the only thing that leaves here
// is a plain object sent back over the message port.

const { parentPort, workerData } = require('worker_threads');

async function main() {
  const { task, buffer } = workerData;

  if (task === 'excel') {
    const { parseExcelEnquiries } = require('./enquiryFileParser');
    return parseExcelEnquiries(Buffer.from(buffer));
  }

  if (task === 'pdf') {
    const { extractText } = require('./pdfParser');
    return extractText(Buffer.from(buffer));
  }

  throw new Error(`Unknown parse task "${task}"`);
}

main()
  .then((value) => parentPort.postMessage({ ok: true, value }))
  .catch((err) => parentPort.postMessage({
    ok: false,
    error: err && err.message ? err.message : String(err),
    status: err && err.status ? err.status : 422,
  }));
