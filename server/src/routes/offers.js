// server/src/routes/offers.js
//
// Offers carry prices and customer names. All of it requires a signed-in user.

const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const { productCode } = require('../middleware/validateParams');
const { requireAuth } = require('../middleware/auth');
const ctrl = require('../controllers/offersController');

router.use(requireAuth);

// productId is a product CODE, not a number — see validateParams.js.
router.get('/fields/:productId', productCode('productId'), asyncHandler(ctrl.getFields));
router.post('/generate', asyncHandler(ctrl.generate));
router.get('/', asyncHandler(ctrl.list));

module.exports = router;
