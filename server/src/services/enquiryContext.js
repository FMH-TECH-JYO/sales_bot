// A full attachment can be many pages long. Read every extracted line, then
// retain the lines that have evidence relevant to the retrieved catalogue
// models. This avoids silently truncating the end of a PDF while keeping the
// local LLM prompt small enough to respond quickly.
const { catalogueText, normalize } = require('./catalogueRetriever');

const SIGNAL = /\b(atex|ex\s*d|flameproof|hart|modbus|4\s*[-/]?\s*20\s*ma|spdt|spst|bar|psi|mbar|mmwc|°c|npt|bsp|accuracy|range|temperature|pressure|level|flow)\b/i;

function lineScore(line, vocabulary) {
  const words = normalize(line).split(' ').filter(Boolean);
  const overlap = words.reduce((total, word) => total + (vocabulary.has(word) ? 1 : 0), 0);
  const numeric = /\d/.test(line) ? 1 : 0;
  return overlap * 3 + (SIGNAL.test(line) ? 2 : 0) + numeric;
}

function prepareEnquiryContext(fullText, retrievedProducts, maxChars = 12000) {
  const vocabulary = new Set(retrievedProducts.flatMap((product) => normalize(catalogueText(product)).split(' ')));
  // Chunk paragraphs/very long table text into readable units. Every unit is
  // scored, so information at the end of the document is considered too.
  const lines = String(fullText || '').split(/\r?\n/).flatMap((line, index) =>
    line.match(/.{1,900}(?:\s|$)/g)?.map((piece) => ({ index, text: piece.trim() })) || []
  ).filter((line) => line.text);
  const selected = lines.map((line) => ({ ...line, score: lineScore(line.text, vocabulary) }))
    .filter((line) => line.score >= 3)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 100)
    .sort((a, b) => a.index - b.index);
  let result = selected.map((line) => line.text).join('\n');
  // For terse documents where scoring found little, preserve the complete text
  // when it fits. For long documents, add the opening context as a fallback.
  if (fullText.length <= maxChars) return fullText;
  if (!result) result = fullText.slice(0, maxChars);
  if (result.length > maxChars) result = result.slice(0, maxChars);
  return result;
}

module.exports = { prepareEnquiryContext };
