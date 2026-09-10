// server/src/routes/catalogueUploads.js
//
// The catalogue library. Every route here is admin-only: these are the calls
// that decide which products the matching engine will offer to customers, and
// until this file was guarded, `POST /catalogue-uploads/1/publish` with no
// credentials at all returned HTTP 200.
//
// Reading is admin-only too, not only writing: an unpublished draft carries the
// extracted price and specification of a product that has not been released.

const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const asyncHandler = require('../middleware/asyncHandler');
const { numericParam } = require('../middleware/validateParams');
const { requireAuth, requireRole } = require('../middleware/auth');
const { heavyLimiter } = require('../middleware/rateLimit');
const ctrl = require('../controllers/catalogueUploadsController');

// Applied to the whole router rather than repeated per line: a guard that has
// to be remembered on each new route is a guard that will eventually be
// forgotten on one, which is how this file got into the state it was in.
router.use(requireAuth, requireRole('admin'));

router.post('/', heavyLimiter, upload.single('file'), asyncHandler(ctrl.uploadCatalogue));
router.get('/', asyncHandler(ctrl.listCatalogueUploads));
router.get('/status-counts', asyncHandler(ctrl.statusCounts));
router.get('/:id', numericParam('id'), asyncHandler(ctrl.getCatalogueUpload));
router.get('/:id/file', numericParam('id'), asyncHandler(ctrl.viewCatalogueFile));
router.patch('/:id', numericParam('id'), asyncHandler(ctrl.updateDraft));
router.post('/:id/retry-draft', numericParam('id'), heavyLimiter, asyncHandler(ctrl.retryDraft));
router.post('/:id/publish', numericParam('id'), asyncHandler(ctrl.publishCatalogue));
router.post('/:id/reject', numericParam('id'), asyncHandler(ctrl.rejectCatalogue));
router.post('/:id/reopen', numericParam('id'), asyncHandler(ctrl.reopenUpload));

module.exports = router;
