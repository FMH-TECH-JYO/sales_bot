// server/src/services/llmClient.js
//
// The one function every extraction call in this app goes through, for both
// catalogue drafting (now) and enquiry extraction (Phase 6). Swapping to a
// cloud provider later means writing a second file with this same exported
// shape and changing LLM_PROVIDER in .env — nothing that calls this file
// needs to change.
//
// SPEED NOTES (see .env.example for the new knobs):
//  - keep_alive: without this, Ollama unloads the model from memory ~5min
//    after the last request, so the very next enquiry pays a multi-second
//    "cold load" penalty on top of inference. We keep it warm.
//  - num_predict: uncapped generation means the model can keep emitting
//    tokens (whitespace/repetition) well past a useful answer. Capping it
//    bounds worst-case latency without hurting quality for this schema.
//  - num_ctx: only as large as we actually need — smaller context is faster
//    to process on CPU-only Ollama installs, which is the common case here.
//  - AbortController timeout: previously a hung/overloaded Ollama call had
//    no ceiling — the UI would just spin forever. Now it fails over to the
//    deterministic fallback (see matchEnquiry.js) after OLLAMA_TIMEOUT_MS,
//    so "too slow" becomes "bounded, and degrades gracefully" instead.

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b';
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 20000;
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '30m';
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT) || 700;
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 4096;

/**
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {object} jsonSchema - see productDraftSchema.js for the shape
 * @param {object} [callOptions] - optional per-call overrides, e.g. { timeoutMs, numPredict }
 * @returns {Promise<{ data: object, raw: string, model: string }>}
 */
async function extractStructured(systemPrompt, userText, jsonSchema, callOptions = {}) {
  const provider = process.env.LLM_PROVIDER || 'local-ollama';
  if (provider !== 'local-ollama') {
    throw new Error(`LLM_PROVIDER "${provider}" not implemented yet — only 'local-ollama' exists (Phase 3). Cloud provider comes in a later phase.`);
  }

  const timeoutMs = callOptions.timeoutMs || OLLAMA_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  const startedAt = Date.now();
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        format: jsonSchema,   // this is what forces valid, schema-shaped JSON out
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE, // keep the model resident between requests
        options: {
          temperature: 0.1,   // low temperature — this is extraction, not creative writing
          num_predict: callOptions.numPredict || OLLAMA_NUM_PREDICT,
          num_ctx: OLLAMA_NUM_CTX,
        },
      }),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama did not respond within ${timeoutMs}ms — falling back. If this happens often, try a smaller/faster model, reduce the candidate list, or increase OLLAMA_TIMEOUT_MS.`);
    }
    // Ollama not running is the single most common failure here — give a
    // specific, actionable error instead of a raw fetch failure.
    throw new Error(`Could not reach Ollama at ${OLLAMA_BASE_URL} — is it running? Try "ollama serve" in a terminal. Original error: ${err.message}`);
  } finally {
    clearTimeout(timer);
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

  if (process.env.LLM_TIMING_LOGS) {
    console.log(`[llmClient] ${OLLAMA_MODEL} responded in ${Date.now() - startedAt}ms`);
  }

  return { data, raw: content, model: OLLAMA_MODEL };
}

module.exports = { extractStructured };