// server/src/routes/enquiries.js
//
// Every route requires a signed-in user. GET / and GET /:id return customer
// names, quantities and the full text of what a customer asked for; before
// these guards existed both were readable by anyone who could reach the port.

const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/asyncHandler');
const { numericParam } = require('../middleware/validateParams');
const upload = require('../middleware/uploadEnquiryFile');
const { requireAuth } = require('../middleware/auth');
const { heavyLimiter } = require('../middleware/rateLimit');
const ctrl = require('../controllers/enquiriesController');

router.use(requireAuth);

// upload.single() no-ops (leaves req.file undefined) for a plain JSON
// request, so this route still accepts the old { text } JSON body too.
//
// heavyLimiter because one call can parse a 25 MB PDF and fan out to dozens of
// LLM calls — the most expensive thing a single request can ask this server for.
router.post('/match', heavyLimiter, upload.single('file'), asyncHandler(ctrl.match));

// History. '/match' is declared above '/:id' on purpose — Express matches in
// order, so a '/:id' route registered first would swallow POST /enquiries/match.
router.get('/', asyncHandler(ctrl.list));
router.get('/:id', numericParam('id'), asyncHandler(ctrl.get));

module.exports = router;
