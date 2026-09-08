// server/src/controllers/enquiriesController.js
const { matchEnquiries } = require('../services/matchEnquiry');

// POST /enquiries/match
// Accepts EITHER:
//   - JSON body { text, attachmentNames? }                (typed text only)
//   - multipart/form-data with field "file" (PDF or Excel) and optional
//     field "text" (any typed note to go alongside it)
// A single request can produce MULTIPLE match results — one per enquiry
// found in the text/file. Response shape: { text, items: [...], itemCount }
async function match(req, res) {
  const text = (req.body?.text || '').trim();
  let attachmentNames = [];
  if (req.body?.attachmentNames) {
    try {
      attachmentNames = Array.isArray(req.body.attachmentNames)
        ? req.body.attachmentNames
        : JSON.parse(req.body.attachmentNames);
    } catch {
      attachmentNames = [];
    }
  }
  if (req.file) attachmentNames = [...attachmentNames, req.file.originalname];

  if (!text && !req.file) {
    return res.status(400).json({ error: 'text or file is required' });
  }

  const result = await matchEnquiries(text, { file: req.file, attachmentNames });

  if (result.itemCount === 0) {
    return res.status(422).json({
      error: result.fileWarning || 'Could not extract any enquiries from the supplied text/file.',
    });
  }

  res.json({ text, ...result });
}

module.exports = { match };
