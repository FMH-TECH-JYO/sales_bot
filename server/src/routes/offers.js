// server/src/routes/offers.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const ctrl = require('../controllers/offersController');

router.get('/fields/:productId', asyncHandler(ctrl.getFields));
router.post('/generate', asyncHandler(ctrl.generate));

module.exports = router;
