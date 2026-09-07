// server/src/services/pdfParser.js
//
// Extracts plain text from a PDF buffer. This handles native-text PDFs
// (the majority of datasheets and RFQs). Scanned/image PDFs will return
// little or no text — extractText() flags that so the caller can mark the
// upload as needing OCR (a later phase) instead of silently proceeding
// with garbage.

const pdfParse = require('pdf-parse');

/**
 * @param {Buffer} buffer
 * @returns {Promise<{ text: string, numPages: number, quality: 'native_text'|'likely_scanned' }>}
 */
async function extractText(buffer) {
  const data = await pdfParse(buffer);
  // Postgres TEXT/JSONB columns reject null bytes (0x00) outright — some PDF
  // extractors emit them for certain embedded-font/ligature edge cases.
  // Strip them here, once, so every caller downstream can assume clean text.
  const text = (data.text || '').replace(/\u0000/g, '').trim();

  // Heuristic: a native-text PDF yields a healthy amount of text per page.
  // A scanned PDF run through pdf-parse yields near-nothing (no OCR happened).
  const charsPerPage = data.numpages > 0 ? text.length / data.numpages : 0;
  const quality = charsPerPage < 50 ? 'likely_scanned' : 'native_text';

  return { text, numPages: data.numpages, quality };
}

module.exports = { extractText };