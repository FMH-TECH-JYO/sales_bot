// server/test/compareAttributes.test.js
//
// The attribute-level comparison is what the sales engineer actually reads:
// "you asked for this, the product gives you that, here is the difference".
// Getting it wrong is worse than having no answer, because a wrong MATCH is
// acted on. Every case below is either a documented rule or a regression.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  compareAttributes, compareValue, labelKey, parseQuantity, productAttributes,
} = require('../src/services/compareAttributes');

describe('labelKey', () => {
  test('an exact label name wins over a longer phrase containing it', () => {
    // Regression. The synonym group for "element diameter" was capturing the
    // bare label "Element", so a customer's "Element: Pt100" was compared
    // against the product's element DIAMETER — a number against a sensor type.
    // Same failure for "Sheath length" swallowing "Sheath", and "Output type"
    // swallowing "Type". The resolver now tries exact names first.
    assert.notEqual(labelKey('Element'), labelKey('Element diameter'));
    assert.notEqual(labelKey('Sheath'), labelKey('Sheath length'));
    assert.notEqual(labelKey('Type'), labelKey('Output type'));
  });

  test('genuine synonyms still fold together', () => {
    assert.equal(labelKey('Process connection'), labelKey('process conn.'));
    assert.equal(labelKey('MOC'), labelKey('Material of construction'));
  });

  test('case and punctuation do not matter', () => {
    assert.equal(labelKey('PROCESS CONNECTION'), labelKey('  process connection  '));
  });
});

describe('parseQuantity', () => {
  test('reads a number with its unit', () => {
    assert.deepEqual(parseQuantity('6 mm'), { n: 6, unit: 'mm' });
    assert.deepEqual(parseQuantity('-40'), { n: -40, unit: null });
  });

  test('reads an inch fraction', () => {
    assert.equal(parseQuantity('1/2"').n, 0.5);
  });

  test('is anchored: it does not find a number buried in prose', () => {
    // THE regression that mattered most. "PT 100, 3 Wire" versus "Pt100, film
    // type" was reported as a MATCH, because an unanchored /\d+/ found "100"
    // in both strings and compared 100 to 100. Two completely different sensor
    // specifications were shown to the engineer as identical.
    assert.equal(parseQuantity('PT 100, 3 Wire'), null);
    assert.equal(parseQuantity('Pt100, film type'), null);
    assert.equal(parseQuantity('SS316 body, 10 mm'), null);
  });
});

describe('compareValue', () => {
  test('identical values match', () => {
    assert.equal(compareValue('SS316', 'SS316').verdict, 'match');
    assert.equal(compareValue('ss316', 'SS316').verdict, 'match');
  });

  test('different values are a deviation, not a match', () => {
    assert.equal(compareValue('SS316', 'SS304').verdict, 'deviation');
  });

  test('the PT100 regression: different sensors are not a match', () => {
    const v = compareValue('PT 100, 3 Wire', 'Pt100, film type').verdict;
    assert.notEqual(v, 'match');
  });

  test('a value the datasheet is silent about is unclear, never a match', () => {
    // The application's stated rule: unconfirmed is reported as missing, never
    // assumed. Reporting silence as agreement is how a wrong offer gets sent.
    const v = compareValue('SS316', null);
    assert.equal(v.verdict, 'unclear');
    assert.match(v.note, /does not state/i);
  });

  test('a value that was not requested is unclear', () => {
    assert.equal(compareValue('', 'SS316').verdict, 'unclear');
    assert.equal(compareValue(null, 'SS316').verdict, 'unclear');
  });
});

describe('compareAttributes', () => {
  test('reports matches, deviations and unconfirmed separately', () => {
    const requested = [
      { label: 'Material', value: 'SS316' },
      { label: 'Process connection', value: '1/2" NPT' },
      { label: 'Sheath length', value: '250 mm' },
    ];
    const actual = [
      { label: 'MOC', value: 'SS316' },                 // synonym, same value
      { label: 'Process connection', value: '1" NPT' }, // stated, different
      // sheath length absent entirely
    ];
    const r = compareAttributes(requested, actual);
    assert.equal(r.rows.length, 3);
    assert.equal(r.matched, 1);
    assert.equal(r.deviations, 1);
    assert.equal(r.unconfirmed, 1);
  });

  test('unconfirmed attributes drag the score down rather than being ignored', () => {
    // A product whose datasheet answers one question out of ten is not a 100%
    // match on the strength of that one answer.
    const requested = Array.from({ length: 10 }, (_, i) => ({ label: `Field ${i}`, value: 'x' }));
    const actual = [{ label: 'Field 0', value: 'x' }];
    const r = compareAttributes(requested, actual);
    assert.equal(r.matched, 1);
    assert.equal(r.unconfirmed, 9);
    assert.equal(r.score, 10);
  });

  test('nothing requested scores zero rather than dividing by zero', () => {
    const r = compareAttributes([], [{ label: 'Material', value: 'SS316' }]);
    assert.equal(r.score, 0);
    assert.deepEqual(r.rows, []);
  });

  test('every requested attribute appears in the output, matched or not', () => {
    // The engineer has to be able to see what was asked for and NOT answered.
    // Dropping unanswered rows is how "we never noticed they wanted a flange
    // rating" happens.
    const requested = [
      { label: 'Flange rating', value: 'ASA 150#' },
      { label: 'Wetted parts', value: 'Hastelloy C' },
    ];
    const r = compareAttributes(requested, []);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows.map((x) => x.parameter), ['Flange rating', 'Wetted parts']);
    assert.ok(r.rows.every((x) => x.verdict === 'unclear'));
  });
});

describe('productAttributes', () => {
  test('a null column is omitted, not rendered as an empty answer', () => {
    // The old screen printed "Range: to" and "Max temp: °C" for products whose
    // columns were empty — an empty string presented as the product's answer.
    const attrs = productAttributes({
      id: 1, model: 'FMPT-012', val_min: null, val_max: null, range_unit: null,
      max_temp_c: null, material: 'SS316', extra_specs: [],
    });
    const labels = attrs.map((a) => a.label.toLowerCase());
    assert.equal(labels.includes('range'), false);
    assert.ok(attrs.every((a) => String(a.value).trim() !== ''));
  });

  test('the spec table is merged in alongside the fixed columns', () => {
    const attrs = productAttributes({
      id: 1, model: 'FMPT-012', material: 'SS316',
      extra_specs: [{ label: 'Accuracy', value: '±0.5%' }],
    });
    assert.ok(attrs.some((a) => a.label === 'Accuracy' && a.value === '±0.5%'));
  });
});
