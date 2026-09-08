// server/src/routes/enquiries.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const upload = require('../middleware/uploadEnquiryFile');
const ctrl = require('../controllers/enquiriesController');

// upload.single() no-ops (leaves req.file undefined) for a plain JSON
// request, so this route still accepts the old { text } JSON body too.
router.post('/match', upload.single('file'), asyncHandler(ctrl.match));

module.exports = router;
