// server/src/routes/enquiries.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const upload = require('../middleware/uploadEnquiryFile');
const ctrl = require('../controllers/enquiriesController');

// upload.single() no-ops (leaves req.file undefined) for a plain JSON
// request, so this route still accepts the old { text } JSON body too.
router.post('/match', upload.single('file'), asyncHandler(ctrl.match));

// History. '/match' is declared above '/:id' on purpose — Express matches in
// order, so a '/:id' route registered first would swallow POST /enquiries/match.
router.get('/', asyncHandler(ctrl.list));
router.get('/:id', asyncHandler(ctrl.get));

module.exports = router;
