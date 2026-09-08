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
    if (okTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type "${file.mimetype}" for enquiry matching — only PDF and Excel (.xlsx/.xls) content is parsed. Other attachments can still be added as reference, but their content won't drive matching.`));
    }
  },
});

module.exports = upload;
