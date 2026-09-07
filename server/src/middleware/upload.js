// server/src/middleware/upload.js
//
// Multer config used by any route that accepts a file upload. Memory
// storage (not disk) because storage/index.js decides where the file
// actually ends up — this middleware's only job is getting the bytes
// off the HTTP request safely.

const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — generous for a datasheet PDF
  fileFilter: (req, file, cb) => {
    const okTypes = ['application/pdf'];
    if (okTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type "${file.mimetype}" — only PDF is accepted in Phase 2. DOCX/XLSX enquiry parsing comes later.`));
    }
  },
});

module.exports = upload;