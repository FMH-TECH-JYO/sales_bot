// server/src/routes/catalogueUploads.js
const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const asyncHandler = require('../middleware/asyncHandler');
const ctrl = require('../controllers/catalogueUploadsController');

router.post('/', upload.single('file'), asyncHandler(ctrl.uploadCatalogue));
router.get('/', asyncHandler(ctrl.listCatalogueUploads));
router.get('/status-counts', asyncHandler(ctrl.statusCounts));
router.get('/:id', asyncHandler(ctrl.getCatalogueUpload));
router.get('/:id/file', asyncHandler(ctrl.viewCatalogueFile));
router.patch('/:id', asyncHandler(ctrl.updateDraft));
router.post('/:id/retry-draft', asyncHandler(ctrl.retryDraft));
router.post('/:id/publish', asyncHandler(ctrl.publishCatalogue));
router.post('/:id/reject', asyncHandler(ctrl.rejectCatalogue));
router.post('/:id/reopen', asyncHandler(ctrl.reopenUpload));

module.exports = router;