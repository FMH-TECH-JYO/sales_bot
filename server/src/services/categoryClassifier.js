// server/src/services/categoryClassifier.js
//
// Fallback for when detectCategory()'s deterministic alias/label matching
// (parseEnquiryText.js + categoryAliases.js) finds nothing — e.g. the
// customer described the product entirely by application ("something to
// shut down the boiler feed pump on low level") rather than naming it.
// Constrained via JSON schema `enum` to the REAL category id list fetched
// live from the database, so the model can only pick a category that
// actually exists (or say none fit) — it can never invent one.

const { extractStructured } = require('./llmClient');

const SYSTEM_PROMPT = `You classify a customer enquiry into exactly one product category from the given list, based on what instrument they're describing (by function, application, or name — not necessarily using the category's exact wording).
If the enquiry clearly doesn't describe any instrument in the list, or gives no usable technical/product detail at all, return category_id: null.
Never return a category_id that isn't in the list you were given.`;

function buildSchema(categoryIds) {
  return {
    type: 'object',
    properties: {
      category_id: {
        type: ['string', 'null'],
        enum: [...categoryIds, null],
        description: 'One of the given category ids, or null if none fit.',
      },
    },
    required: ['category_id'],
  };
}

/**
 * @param {string} text
 * @param {Array<{id:string,label:string}>} categories
 * @returns {Promise<string|null>}
 */
async function classifyCategory(text, categories) {
  if (!text || !categories?.length) return null;
  const schema = buildSchema(categories.map((c) => c.id));
  const userText = `Enquiry text:\n${text}\n\nCategories (id — label):\n${categories.map((c) => `${c.id} — ${c.label}`).join('\n')}`;
  try {
    const { data } = await extractStructured(SYSTEM_PROMPT, userText, schema);
    const id = data.category_id;
    if (id && categories.some((c) => c.id === id)) return id;
    return null;
  } catch (err) {
    console.error('LLM category classification failed:', err.message);
    return null;
  }
}

module.exports = { classifyCategory };
