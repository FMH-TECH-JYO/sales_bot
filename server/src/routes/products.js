// server/src/routes/products.js
//
// The published catalogue. Readable by any signed-in user — sales engineers
// need it constantly — but not by the anonymous internet: list_price is on
// these rows, and a competitor reading the whole price list off an unguarded
// endpoint is a commercial problem even though it is not a security one.

const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const { productCode } = require('../middleware/validateParams');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/productsController');

router.use(requireAuth);

router.get('/', asyncHandler(ctrl.listProducts));
// products.id is TEXT — the model code, 'FMLG-BM' / 'FMDPT-6000' / 'FD' —
// NOT a serial integer. A numeric validator here rejects every real product.
router.get('/:id', productCode('id'), asyncHandler(ctrl.getProduct));
router.get('/:id/catalogue', productCode('id'), asyncHandler(ctrl.downloadCatalogue));

module.exports = router;
