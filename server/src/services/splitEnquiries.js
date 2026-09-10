// server/src/services/splitEnquiries.js
//
// Splits a block of free-form enquiry text (typed into chat, or extracted
// from a PDF) into one or more separate product enquiries. Same two-stage
// split as everywhere else in this codebase: try classical/deterministic
// pattern matching FIRST (numbered lists, blank-line paragraphs, obvious
// "Item 2:" markers); only fall back to the LLM when the text is too
// unstructured for that to work. This keeps the common case (a clean
// numbered RFQ) instant and exact, and reserves the LLM for genuinely
// ambiguous prose.
//
// IMPORTANT: this never invents content. The LLM path is constrained to
// return VERBATIM substrings of the original text (checked below — any
// item that doesn't match the source text closely enough is discarded and
// the whole text is treated as a single enquiry instead of risking
// fabricated/altered requirements).

const { extractStructured } = require('./llmClient');

// Matches a line that opens a new numbered/lettered item, e.g.
// "1.", "1)", "Item 1:", "Enquiry 2 -", "(a)", "Sr No 3."
// Inside a character class ( and [ need no escape, and a trailing - is a
// literal hyphen. The escaped forms worked but read as though they were doing
// something; written plainly, the class is obviously "one of ) ] . : -".
const NUMBERED_ITEM_RE = /^\s*(?:item|enquiry|sr\.?\s?no\.?|s\.?\s?no\.?)?\s*[([]?(\d{1,3}|[a-zA-Z])[)\].:-]\s+/i;

/**
 * Deterministic pass: split on blank-line-separated paragraphs, then check
 * whether paragraphs look like a numbered list (in which case merge any
 * numbering-less continuation lines into the preceding item).
 * @returns {string[]|null} null if no confident split found
 */
function heuristicSplit(text) {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return null;

  const lines = normalized.split('\n');
  const numberedStarts = lines
    .map((line, i) => ({ i, isStart: NUMBERED_ITEM_RE.test(line) }))
    .filter((x) => x.isStart);

  if (numberedStarts.length >= 2) {
    const items = [];
    for (let n = 0; n < numberedStarts.length; n++) {
      const start = numberedStarts[n].i;
      const end = n + 1 < numberedStarts.length ? numberedStarts[n + 1].i : lines.length;
      const chunk = lines.slice(start, end).join('\n').trim();
      if (chunk) items.push(chunk);
    }
    if (items.length >= 2) return items;
  }

  // Fall back to blank-line-separated paragraphs, but only treat this as a
  // real multi-enquiry split if several of them look like they carry real
  // technical content (contain a digit — ranges/temperatures/quantities
  // almost always do). A paragraph with no digit at all (an intro line like
  // "We need pricing for the following items", or a closing pleasantry) is
  // dropped rather than kept as its own bogus "enquiry" — it carries no
  // requirement of its own to match against.
  const paragraphs = normalized.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length >= 2) {
    const withDigits = paragraphs.filter((p) => /\d/.test(p));
    if (withDigits.length >= 2 && withDigits.length / paragraphs.length >= 0.5) {
      return withDigits;
    }
  }

  return null;
}

const splitSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'string', description: 'Verbatim excerpt of the source text covering exactly one product enquiry. Copy the original wording — do not summarize, paraphrase, or add information.' },
    },
  },
  required: ['items'],
};

const SPLIT_SYSTEM_PROMPT = `You split a customer enquiry document into separate product requests.
Each item in your output must be a VERBATIM copy of the portion of the source text that describes ONE product/instrument requirement — do not reword, summarize, translate, or add anything.
If the text only describes ONE product, return a single item containing the whole text.
Never merge two different products into one item, and never split a single product's requirement across two items.`;

/**
 * Loose containment check used to reject any LLM "item" that isn't
 * substantially the source text (guards against paraphrasing/hallucination).
 */
function isVerbatimEnough(item, sourceText) {
  const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const normItem = normalize(item);
  if (!normItem) return false;
  const normSource = normalize(sourceText);
  if (normSource.includes(normItem)) return true;
  // Allow minor whitespace/punctuation drift: require most of the item's
  // significant words to appear in the source, in order, as a fallback.
  const words = normItem.split(' ').filter((w) => w.length > 2);
  if (words.length === 0) return false;
  let found = 0;
  let searchFrom = 0;
  for (const w of words) {
    const idx = normSource.indexOf(w, searchFrom);
    if (idx >= 0) { found++; searchFrom = idx; }
  }
  return found / words.length >= 0.85;
}

async function llmAssistedSplit(text) {
  const userText = `Source text:\n${text}`;
  const { data } = await extractStructured(SPLIT_SYSTEM_PROMPT, userText, splitSchema);
  const items = (data.items || []).map((s) => String(s).trim()).filter(Boolean);
  const verified = items.filter((item) => isVerbatimEnough(item, text));
  if (verified.length === 0) return [text]; // couldn't verify anything — safest is to treat as one enquiry
  return verified;
}

/**
 * @param {string} text
 * @returns {Promise<{ items: string[], method: 'heuristic'|'llm'|'single' }>}
 */
async function splitEnquiryText(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { items: [], method: 'single' };

  const heuristic = heuristicSplit(trimmed);
  if (heuristic) return { items: heuristic, method: 'heuristic' };

  // Only worth an LLM call for text long/complex enough that it PLAUSIBLY
  // contains more than one enquiry — a short one-liner is virtually always
  // a single request, and skipping the call keeps the common case fast.
  const plausiblyMultiple = trimmed.length > 220 || (trimmed.match(/\bpressure\b|\btransmitter\b|\bswitch\b|\bgauge\b|\btemperature\b|\blevel\b/gi) || []).length >= 2;
  if (!plausiblyMultiple) return { items: [trimmed], method: 'single' };

  try {
    const items = await llmAssistedSplit(trimmed);
    return { items, method: items.length > 1 ? 'llm' : 'single' };
  } catch (err) {
    console.error('LLM-assisted enquiry split failed, treating as one enquiry:', err.message);
    return { items: [trimmed], method: 'single' };
  }
}

module.exports = { splitEnquiryText, heuristicSplit };
