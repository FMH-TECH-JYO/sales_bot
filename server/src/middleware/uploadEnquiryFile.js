// server/src/middleware/uploadEnquiryFile.js
//
// Multer config for the enquiry-matching endpoint specifically. Kept
// separate from middleware/upload.js (catalogue uploads), which is
// deliberately PDF-only — enquiries additionally accept Excel, since a
// sales team is far more likely to paste/forward a spreadsheet of RFQ line
// items than a formatted datasheet-style PDF.

const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel', // .xls
    ];
    // Browsers are unreliable about spreadsheet MIME types — Windows Chrome
    // sends application/octet-stream (or an empty string) for .xlsx whenever
    // the file association is missing or unusual. Judging on MIME alone
    // rejected perfectly good enquiry files, so the extension is authoritative
    // and the MIME type is a fallback.
    const ext = (file.originalname.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    const okExts = ['.pdf', '.xlsx', '.xls', '.xlsm'];
    if (okExts.includes(ext) || okTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const err = new Error(`Can't read "${file.originalname}" for matching — only PDF and Excel (.xlsx/.xls) content is parsed (this arrived as "${file.mimetype || 'no type'}"). Attach it as reference if you just want it listed.`);
      err.status = 400;
      cb(err);
    }
  },
});

module.exports = upload;
