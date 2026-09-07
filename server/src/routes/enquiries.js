// server/src/routes/enquiries.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const ctrl = require('../controllers/enquiriesController');

router.post('/match', asyncHandler(ctrl.match));

module.exports = router;
