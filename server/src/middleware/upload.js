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
    const ext = (file.originalname.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    const allowed = ['.pdf', '.docx', '.docm', '.dotx', '.xlsx', '.xlsm', '.xltx', '.csv', '.tsv', '.txt', '.md', '.text'];
    cb(allowed.includes(ext) ? null : new Error(`Unsupported attachment "${file.originalname}". Use PDF, DOCX, XLSX, CSV, TSV, TXT, or MD.`), allowed.includes(ext));
  },
});

module.exports = upload;
