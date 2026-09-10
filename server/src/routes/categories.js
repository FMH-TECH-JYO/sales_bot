// server/src/routes/categories.js
//
// Listing categories needs a login (it is the product taxonomy, not public
// marketing copy). CREATING one is an admin act: a category is what the
// matching engine searches within, so anyone who can add one can steer where
// enquiries land.

const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/categoriesController');

router.get('/', requireAuth, asyncHandler(ctrl.listCategories));
router.post('/', requireAuth, requireRole('admin'), asyncHandler(ctrl.createCategory));

module.exports = router;
