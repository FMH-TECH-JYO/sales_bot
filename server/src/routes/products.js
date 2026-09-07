// server/src/routes/products.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const ctrl = require('../controllers/productsController');

router.get('/', asyncHandler(ctrl.listProducts));
router.get('/:id', asyncHandler(ctrl.getProduct));
router.get('/:id/catalogue', asyncHandler(ctrl.downloadCatalogue));

module.exports = router;