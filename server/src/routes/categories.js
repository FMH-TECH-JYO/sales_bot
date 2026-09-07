// server/src/routes/categories.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const ctrl = require('../controllers/categoriesController');

router.get('/', asyncHandler(ctrl.listCategories));
router.post('/', asyncHandler(ctrl.createCategory));

module.exports = router;