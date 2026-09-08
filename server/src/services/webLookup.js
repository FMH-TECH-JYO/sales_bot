// server/src/services/webLookup.js
//
// Internet fallback for matching: internal catalogues are ALWAYS checked
// first (matchEnquiry.js only calls into here for a specific spec that the
// candidate's catalogue entry left unconfirmed). This is deliberately
// pluggable behind WEB_SEARCH_PROVIDER so a real API key can be dropped in
// later without touching matchEnquiry.js — see .env.example.
//
// Anti-hallucination contract, enforced at every layer:
//   1. isEnabled() is false until a provider + API key is configured. When
//      disabled, matchEnquiry.js reports the spec as missing (never guesses).
//   2. search() only returns what the provider's API actually returned —
//      title/url/snippet — never anything synthesized.
//   3. lookupSpec() feeds ONLY those snippets to the LLM with an explicit
//      "answer null if the snippets don't say" instruction, and the caller
//      discards any answer that isn't grounded in a returned source URL.
//   4. Every value that reaches the UI is paired with its source URL. A
//      value with no source is never shown as fact.

const { extractStructured } = require('./llmClient');

const PROVIDER = (process.env.WEB_SEARCH_PROVIDER || 'none').toLowerCase();

function isEnabled() {
  if (PROVIDER === 'tavily') return !!process.env.TAVILY_API_KEY;
  if (PROVIDER === 'serper') return !!process.env.SERPER_API_KEY;
  return false;
}

async function searchTavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: 5,
      search_depth: 'basic',
    }),
  });
  if (!res.ok) throw new Error(`Tavily search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function searchSerper(query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query }),
  });
  if (!res.ok) throw new Error(`Serper search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, 5).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet }));
}

/**
 * @param {string} query
 * @returns {Promise<Array<{title:string,url:string,snippet:string}>>} empty array on any failure — never throws to callers, so a flaky provider degrades to "missing", not a crash.
 */
async function search(query) {
  if (!isEnabled()) return [];
  try {
    if (PROVIDER === 'tavily') return await searchTavily(query);
    if (PROVIDER === 'serper') return await searchSerper(query);
    return [];
  } catch (err) {
    console.error(`Web search failed (${PROVIDER}):`, err.message);
    return [];
  }
}

const lookupSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'true only if one of the provided sources explicitly states the answer.' },
    value: { type: ['string', 'null'], description: 'The value as stated in a source, verbatim or near-verbatim. Null if not found.' },
    source_index: { type: ['number', 'null'], description: 'Index (0-based) into the provided source list that supports this value. Null if not found.' },
  },
  required: ['found'],
};

const LOOKUP_SYSTEM_PROMPT = `You answer a specific technical question using ONLY the search result snippets given to you.
If none of the snippets state the answer clearly, set found=false and value=null — do NOT guess, infer from general knowledge, or use information not present in the snippets.
If a snippet does state it, quote or closely paraphrase that snippet's own wording and give its index.`;

/**
 * Attempts to ground-truth a single missing spec via the web, strictly from
 * search snippets — never from the model's own trained knowledge.
 * @param {string} question - e.g. "What is the maximum operating temperature of the Forbes Marshall WP pressure switch?"
 * @returns {Promise<{ found: boolean, value: string|null, source: {title:string,url:string}|null }>}
 */
async function lookupSpec(question) {
  if (!isEnabled()) return { found: false, value: null, source: null, disabled: true };

  const results = await search(question);
  if (results.length === 0) return { found: false, value: null, source: null };

  const userText = `Question: ${question}\n\nSources:\n${results.map((r, i) => `[${i}] ${r.title}\n${r.snippet}\nURL: ${r.url}`).join('\n\n')}`;
  try {
    const { data } = await extractStructured(LOOKUP_SYSTEM_PROMPT, userText, lookupSchema);
    if (!data.found || data.value == null || data.source_index == null || !results[data.source_index]) {
      return { found: false, value: null, source: null };
    }
    const src = results[data.source_index];
    return { found: true, value: data.value, source: { title: src.title, url: src.url } };
  } catch (err) {
    console.error('Web lookup grounding failed:', err.message);
    return { found: false, value: null, source: null };
  }
}

module.exports = { isEnabled, search, lookupSpec, PROVIDER };
