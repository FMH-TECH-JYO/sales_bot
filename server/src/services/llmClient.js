// server/src/services/llmClient.js
//
// The one function every extraction call in this app goes through, for both
// catalogue drafting (now) and enquiry extraction (Phase 6). Swapping to a
// cloud provider later means writing a second file with this same exported
// shape and changing LLM_PROVIDER in .env — nothing that calls this file
// needs to change.

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b';

/**
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {object} jsonSchema - see productDraftSchema.js for the shape
 * @returns {Promise<{ data: object, raw: string, model: string }>}
 */
async function extractStructured(systemPrompt, userText, jsonSchema) {
  const provider = process.env.LLM_PROVIDER || 'local-ollama';
  if (provider !== 'local-ollama') {
    throw new Error(`LLM_PROVIDER "${provider}" not implemented yet — only 'local-ollama' exists (Phase 3). Cloud provider comes in a later phase.`);
  }

  let response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        format: jsonSchema,   // this is what forces valid, schema-shaped JSON out
        stream: false,
        options: { temperature: 0.1 }, // low temperature — this is extraction, not creative writing
      }),
    });
  } catch (err) {
    // Ollama not running is the single most common failure here — give a
    // specific, actionable error instead of a raw fetch failure.
    throw new Error(`Could not reach Ollama at ${OLLAMA_BASE_URL} — is it running? Try "ollama serve" in a terminal. Original error: ${err.message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama returned HTTP ${response.status}: ${body}`);
  }

  const payload = await response.json();
  const content = payload?.message?.content;
  if (!content) {
    throw new Error(`Ollama response had no message.content — got: ${JSON.stringify(payload).slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`Model output was not valid JSON despite schema constraint — check the Ollama version supports the "format" parameter. Raw content: ${content.slice(0, 300)}`);
  }

  return { data, raw: content, model: OLLAMA_MODEL };
}

module.exports = { extractStructured };