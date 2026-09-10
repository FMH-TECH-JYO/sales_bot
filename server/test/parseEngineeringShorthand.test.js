// server/test/parseEngineeringShorthand.test.js
//
// The single line below is a REAL enquiry, copied verbatim from a customer's
// sheet. Before the shorthand parser existed, the prose-oriented parser read
// NOTHING out of it — no pressure, no temperature, no connection — so every
// candidate stayed at its 0.5 starting score and six products tied at 50%.
//
// Almost every requirement is in there and is perfectly machine-readable. It is
// codes, not language, which is why a regex and a dictionary beat a model here:
// exact, instant, free, and it still works when Ollama is down.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseEngineeringShorthand, readEnquiryAttributes } = require('../src/services/parseEngineeringShorthand');

const REAL_ENQUIRY =
  'LG,FINISHED,TUBLR,CC-1450MM,PC-1"ASA 150#MS+POWDER COAT,WTD PTS-MS+POWDER ' +
  'COATED,GLND-MS,GLS-19MMOD PKG-PTFE,ISO VLV-2 NO,ATO SHT OFF BL CHK VLV OFST ' +
  'TRM-SS316,SCL-AL,LC-5MM,DRN&VNT-1/2"NPT VLV&PLUG+POWER COATED,10KG,100 DEGGC';

describe('parseEngineeringShorthand on a real enquiry', () => {
  const r = parseEngineeringShorthand(REAL_ENQUIRY);

  test('reads the design pressure', () => {
    assert.deepEqual(r.designPressure, { value: 10, unit: 'kg/cm²' });
  });

  test('reads the design temperature through the customer\'s typo', () => {
    // "100 DEGGC" — two Gs — is what the customer actually wrote. A strict
    // /DEG ?C/ would have missed it and thrown away a stated requirement.
    assert.equal(r.tempMax, 100);
  });

  test('reads the process connection with its pressure class', () => {
    assert.equal(r.connection, '1" ASA 150#');
  });

  test('normalises centre-to-centre rather than leaving it as 1450MM', () => {
    const cc = r.attributes.find((a) => a.label === 'Centre to centre');
    assert.equal(cc.value, '1450 mm');
  });

  test('the packing is not swallowed by the glass field', () => {
    // Regression. "GLS-19MMOD PKG-PTFE" read as ONE field whose value was
    // "19MMOD PKG-PTFE", and the PTFE packing — a real, quotable requirement —
    // silently vanished. A prefixed value now stops at the next known prefix,
    // not just at the next comma.
    const packing = r.attributes.find((a) => a.label === 'Packing');
    assert.ok(packing, 'the PTFE packing was lost');
    assert.equal(packing.value, 'PTFE');

    const glass = r.attributes.find((a) => a.label === 'Glass');
    assert.equal(glass.value.includes('PKG'), false, 'the glass field swallowed the packing');
  });

  test('reads the trim material', () => {
    const trim = r.attributes.find((a) => a.label === 'Trim');
    assert.equal(trim.value, 'SS316');
  });

  test('identifies the instrument style', () => {
    assert.equal(r.instrumentStyle, 'Tubular');
  });

  test('collects the materials mentioned', () => {
    assert.ok(r.materials.includes('SS316'));
    assert.ok(r.materials.includes('PTFE'));
    assert.ok(r.materials.includes('Mild steel'));
  });

  test('produces enough evidence for the confidence gate to work with', () => {
    // Zero evidence is what made the six-way 50% tie unusable. This line has
    // plenty; the point of the parser is that it is now visible.
    assert.ok(r.attributes.length >= 8, `only ${r.attributes.length} attributes read`);
  });
});

describe('parseEngineeringShorthand edge cases', () => {
  test('empty and junk input returns empty results rather than throwing', () => {
    for (const junk of ['', null, undefined, '   ', ',,,,', '-----']) {
      const r = parseEngineeringShorthand(junk);
      assert.deepEqual(r.attributes, []);
      assert.equal(r.designPressure, null);
    }
  });

  test('does not invent values it cannot see', () => {
    // Conservatism is the whole design: anything unrecognised is left for the
    // model rather than guessed. An enquiry with no pressure must not acquire one.
    const r = parseEngineeringShorthand('Please quote for a pressure gauge, dial type.');
    assert.equal(r.designPressure, null);
    assert.equal(r.tempMax, null);
    assert.equal(r.connection, null);
  });

  test('reads bar and psi as well as kg/cm²', () => {
    assert.deepEqual(parseEngineeringShorthand('16 BARG').designPressure, { value: 16, unit: 'bar' });
    assert.deepEqual(parseEngineeringShorthand('150 PSIG').designPressure, { value: 150, unit: 'psi' });
  });

  test('reads negative temperatures', () => {
    assert.equal(parseEngineeringShorthand('-40 DEG C').tempMax, -40);
  });
});

describe('readEnquiryAttributes', () => {
  test('merges shorthand codes with prose label/value pairs', () => {
    // Both styles occur, sometimes in the same message.
    const merged = readEnquiryAttributes('10KG, 100 DEGGC\nSheath Dia : 6 mm\nElement : Pt100');
    const labels = merged.attributes.map((a) => a.label.toLowerCase());
    assert.ok(labels.some((l) => l.includes('design pressure')));
    assert.ok(labels.some((l) => l.includes('sheath')));
    assert.ok(labels.some((l) => l.includes('element')));
  });

  test('a shorthand reading wins over a labelled duplicate rather than appearing twice', () => {
    const merged = readEnquiryAttributes('10KG\nDesign pressure : something else');
    const pressures = merged.attributes.filter((a) => a.label.toLowerCase() === 'design pressure');
    assert.equal(pressures.length, 1);
    assert.equal(pressures[0].value, '10 kg/cm²');
  });
});
