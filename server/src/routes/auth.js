// server/src/routes/auth.js
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const { numericParam } = require('../middleware/validateParams');
const { loginLimiter } = require('../middleware/rateLimit');
const ctrl = require('../controllers/authController');

// Public. loginLimiter caps guesses per IP; the per-account lockout in the
// controller covers guesses spread across many IPs.
router.post('/login', loginLimiter, asyncHandler(ctrl.login));

// Logout is deliberately NOT behind requireAuth: an expired or already-revoked
// token should still clear the client's cookie rather than return 401 and
// leave the browser holding a dead session.
router.post('/logout', asyncHandler(ctrl.logout));

router.get('/me', requireAuth, asyncHandler(ctrl.me));
router.post('/password', requireAuth, asyncHandler(ctrl.changePassword));

router.get('/users', requireAuth, requireRole('admin'), asyncHandler(ctrl.listUsers));
router.post('/users', requireAuth, requireRole('admin'), asyncHandler(ctrl.createUser));
// Guards first, then shape validation: an anonymous caller should be told
// "sign in", not "that id is malformed".
router.patch('/users/:id', requireAuth, requireRole('admin'), numericParam('id'), asyncHandler(ctrl.updateUser));

module.exports = router;
