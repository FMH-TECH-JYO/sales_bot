// server/src/controllers/enquiriesController.js
const { matchEnquiry } = require('../services/matchEnquiry');

// POST /enquiries/match   { text: string }
async function match(req, res) {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const result = await matchEnquiry(text);
  res.json({ text, ...result });
}

module.exports = { match };
