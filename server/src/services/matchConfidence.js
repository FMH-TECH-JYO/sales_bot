// server/src/services/matchConfidence.js
//
// Decides whether a set of match results is trustworthy enough to show as a
// match at all.
//
// WHY THIS EXISTS
// ---------------
// A real enquiry ("LG,FINISHED,TUBLR,CC-1450MM,PC-1\"ASA 150#...") produced six
// level gauges scored at EXACTLY 50% each, presented as "FMLG-BM — 50% OVERALL
// MATCH" with a "Proceed with Offer Generation" button underneath.
//
// Both facts were visible in the data and neither was acted on:
//   * fallbackScore() starts every product at 0.5 and only moves it when the
//     enquiry parse produced a range / hazard / output. Nothing parsed, so
//     nothing moved. 50% did not mean "half a match" — it meant "no
//     information at all".
//   * Six identical scores is not a ranking. It is the scorer saying it cannot
//     tell these products apart.
//
// The app's own stated principle is that unconfirmed specs are reported as
// missing, never guessed. Ranking six indistinguishable products and offering
// to quote the first one breaks that principle, and a wrong quote reaches a
// customer. An honest "I can't match this, here's what's missing" is a correct
// answer; a confident 50% is not.

/** How many enquiry attributes were actually read out of the text. */
function countEvidence(parsed) {
  if (!parsed) return 0;
  let n = 0;
  if (parsed.range && parsed.range.min != null && parsed.range.max != null) n++;
  if (parsed.tempMax != null) n++;
  if (parsed.hazardous) n++;
  if (parsed.outputCandidates && parsed.outputCandidates.length) n++;
  if (parsed.connectionRaw) n++;
  if (parsed.moc) n++;
  // Attributes recovered by the shorthand parser (parseEngineeringShorthand.js)
  if (parsed.shorthand && Array.isArray(parsed.shorthand.attributes)) {
    n += parsed.shorthand.attributes.length;
  }
  return n;
}

/**
 * @param {object} args
 * @param {object} args.parsed    output of parseEnquiryText (+ shorthand merge)
 * @param {Array}  args.results   ranked results, each { percent, product }
 * @param {string} args.provider  'fallback-deterministic' | 'local-ollama-...' | ...
 * @returns {{verdict: 'reliable'|'weak'|'unusable', reasons: string[],
 *            evidence: number, spread: number, tiedAtTop: number,
 *            canGenerateOffer: boolean}}
 */
function assessMatch({ parsed, results = [], provider = '' }) {
  const reasons = [];
  const evidence = countEvidence(parsed);
  const usedFallback = /fallback/i.test(provider);

  const scores = results.map((r) => Number(r.percent) || 0);
  const top = scores.length ? scores[0] : 0;
  const tiedAtTop = scores.filter((s) => s === top).length;
  const spread = scores.length > 1 ? top - scores[scores.length - 1] : 0;

  let verdict = 'reliable';

  if (!results.length) {
    reasons.push('No candidate products were found for this enquiry\'s category.');
    verdict = 'unusable';
  }

  if (evidence === 0) {
    reasons.push(
      'No technical requirement could be read from the enquiry — no range, temperature, ' +
      'area classification, output type, connection or material was recognised. ' +
      'Ranking products against nothing would be guesswork.'
    );
    verdict = 'unusable';
  }

  if (results.length > 1 && tiedAtTop === results.length) {
    reasons.push(
      `All ${results.length} candidates scored identically (${top}%). That is not a ranking — ` +
      'it means nothing in the enquiry distinguishes one product from another.'
    );
    verdict = 'unusable';
  }

  if (usedFallback) {
    reasons.push(
      'The language model was unavailable, so scoring used the deterministic fallback. ' +
      'It compares only range, area classification and output type — it cannot read ' +
      'materials, connections, dimensions or free text.'
    );
    if (verdict !== 'unusable') verdict = evidence >= 3 ? 'weak' : 'unusable';
  }

  if (verdict === 'reliable' && results.length > 1 && tiedAtTop > 1) {
    reasons.push(`${tiedAtTop} products share the top score (${top}%) — they cannot be separated on the stated requirements.`);
    verdict = 'weak';
  }

  if (verdict === 'reliable' && spread < 5 && results.length > 2) {
    reasons.push(`Top and bottom candidates differ by only ${spread} points — the enquiry doesn't discriminate between them.`);
    verdict = 'weak';
  }

  return {
    verdict,
    reasons,
    evidence,
    spread,
    tiedAtTop,
    // An offer is a customer-facing document. It is never generated from a
    // result the system itself does not trust.
    canGenerateOffer: verdict !== 'unusable',
  };
}

module.exports = { assessMatch, countEvidence };
