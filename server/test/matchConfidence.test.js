// server/test/matchConfidence.test.js
//
// The confidence gate is the answer to "giving the wrong match doesn't fall on
// the LLM — the results should be accurate." It does not make matching better;
// it stops the app presenting a guess as a match, and refuses to let an offer
// be generated from one.
//
// The scenario it was built for: a real level-gauge enquiry returned SIX
// products at exactly 50% each, headed "FMLG-BM — 50% OVERALL MATCH" with a
// "Proceed with Offer Generation" button. 50% there did not mean "half a
// match"; it meant the scorer had no information and left every candidate at
// its starting value.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { assessMatch, countEvidence } = require('../src/services/matchConfidence');

const parsedWithEvidence = (n) => ({
  shorthand: { attributes: Array.from({ length: n }, (_, i) => ({ label: `a${i}`, value: 'v' })) },
});

describe('countEvidence', () => {
  test('counts nothing when nothing was parsed', () => {
    assert.equal(countEvidence(null), 0);
    assert.equal(countEvidence({}), 0);
  });

  test('a half-open range is not evidence', () => {
    // "up to 10 bar" with no minimum cannot be compared against a product's
    // range, so counting it would inflate confidence on a requirement the
    // scorer cannot actually use.
    assert.equal(countEvidence({ range: { min: 0, max: null } }), 0);
    assert.equal(countEvidence({ range: { min: 0, max: 10 } }), 1);
  });

  test('shorthand attributes count', () => {
    assert.equal(countEvidence(parsedWithEvidence(4)), 4);
  });
});

describe('assessMatch', () => {
  test('no evidence is UNUSABLE, whatever the scores say', () => {
    const r = assessMatch({
      parsed: {},
      results: [{ percent: 87, product: { id: 1 } }],
      provider: 'local-ollama-llama3.2',
    });
    assert.equal(r.verdict, 'unusable');
    assert.equal(r.canGenerateOffer, false);
    assert.match(r.reasons.join(' '), /No technical requirement/i);
  });

  test('the six-way 50% tie is UNUSABLE', () => {
    // The exact failure this file exists for.
    const r = assessMatch({
      parsed: parsedWithEvidence(5),
      results: Array.from({ length: 6 }, (_, i) => ({ percent: 50, product: { id: i } })),
      provider: 'local-ollama-llama3.2',
    });
    assert.equal(r.verdict, 'unusable');
    assert.equal(r.canGenerateOffer, false);
    assert.equal(r.tiedAtTop, 6);
    assert.match(r.reasons.join(' '), /not a ranking/i);
  });

  test('no candidates at all is UNUSABLE', () => {
    const r = assessMatch({ parsed: parsedWithEvidence(5), results: [], provider: 'local-ollama' });
    assert.equal(r.verdict, 'unusable');
    assert.equal(r.canGenerateOffer, false);
  });

  test('the deterministic fallback with thin evidence is UNUSABLE', () => {
    const r = assessMatch({
      parsed: parsedWithEvidence(2),
      results: [{ percent: 80, product: { id: 1 } }, { percent: 40, product: { id: 2 } }],
      provider: 'fallback-deterministic',
    });
    assert.equal(r.verdict, 'unusable');
  });

  test('the fallback with substantial evidence is WEAK, not silently reliable', () => {
    const r = assessMatch({
      parsed: parsedWithEvidence(6),
      results: [{ percent: 90, product: { id: 1 } }, { percent: 20, product: { id: 2 } }],
      provider: 'fallback-deterministic',
    });
    assert.equal(r.verdict, 'weak');
    assert.equal(r.canGenerateOffer, true);
    assert.match(r.reasons.join(' '), /language model was unavailable/i);
  });

  test('a clear winner on good evidence is RELIABLE', () => {
    const r = assessMatch({
      parsed: parsedWithEvidence(8),
      results: [
        { percent: 92, product: { id: 1 } },
        { percent: 61, product: { id: 2 } },
        { percent: 40, product: { id: 3 } },
      ],
      provider: 'local-ollama-llama3.2',
    });
    assert.equal(r.verdict, 'reliable');
    assert.equal(r.canGenerateOffer, true);
    assert.deepEqual(r.reasons, []);
  });

  test('a tie at the top demotes an otherwise reliable result to WEAK', () => {
    const r = assessMatch({
      parsed: parsedWithEvidence(8),
      results: [
        { percent: 88, product: { id: 1 } },
        { percent: 88, product: { id: 2 } },
        { percent: 30, product: { id: 3 } },
      ],
      provider: 'local-ollama-llama3.2',
    });
    assert.equal(r.verdict, 'weak');
    assert.equal(r.tiedAtTop, 2);
  });

  test('candidates crowded within a few points are WEAK', () => {
    const r = assessMatch({
      parsed: parsedWithEvidence(8),
      results: [
        { percent: 72, product: { id: 1 } },
        { percent: 70, product: { id: 2 } },
        { percent: 69, product: { id: 3 } },
      ],
      provider: 'local-ollama-llama3.2',
    });
    assert.equal(r.verdict, 'weak');
    assert.equal(r.spread, 3);
  });

  test('every unusable verdict carries at least one stated reason', () => {
    // The engineer must be told WHY there is no match, not just that there
    // isn't one — "here's what's missing" is the actionable half.
    for (const args of [
      { parsed: {}, results: [{ percent: 50, product: { id: 1 } }], provider: 'x' },
      { parsed: parsedWithEvidence(5), results: [], provider: 'x' },
    ]) {
      const r = assessMatch(args);
      assert.equal(r.verdict, 'unusable');
      assert.ok(r.reasons.length > 0, 'unusable with no explanation');
    }
  });

  test('canGenerateOffer is false for exactly the unusable verdicts', () => {
    // An offer is a customer-facing document; it is never generated from a
    // result the system itself does not trust.
    const unusable = assessMatch({ parsed: {}, results: [], provider: 'x' });
    assert.equal(unusable.canGenerateOffer, false);
  });
});
