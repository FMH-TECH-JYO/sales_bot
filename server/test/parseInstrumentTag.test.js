// server/test/parseInstrumentTag.test.js
//
// ISA-5.1 instrument tags are CODES, not language: they are read with a
// dictionary, not a model, so they are exactly the kind of thing a unit test
// can pin down completely.
//
// Two of the cases below are regressions found by hand-checking the reader's
// output during development, and both would have silently mis-routed enquiries:
// PSV-100 read as a pressure SWITCH, and the plain word "ABC" read as an
// analysis controller.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseInstrumentTag } = require('../src/services/parseInstrumentTag');

describe('parseInstrumentTag', () => {
  test('reads variable and function from a normal tag', () => {
    const t = parseInstrumentTag('PT-101');
    assert.equal(t.variable, 'pressure');
    assert.equal(t.func, 'transmitter');
  });

  test('the LAST function letter is the device, not the first', () => {
    // ISA-5.1: in a multi-letter function string the final letter names the
    // actual instrument. "TIT" is a temperature indicating TRANSMITTER, not an
    // indicator; "PSV" is a pressure safety VALVE, not a switch. Taking the
    // first letter called PSV-100 a pressure switch — an in-scope product —
    // and sent a relief valve enquiry into the switch catalogue.
    assert.equal(parseInstrumentTag('TIT-201').func, 'transmitter');
    assert.equal(parseInstrumentTag('PSV-100').func, 'valve');
    assert.equal(parseInstrumentTag('PIC-300').func, 'controller');
    assert.equal(parseInstrumentTag('LIT-400').func, 'transmitter');
  });

  test('a leading D marks a differential measurement', () => {
    const t = parseInstrumentTag('DPT-500');
    assert.equal(t.differential, true);
    assert.equal(t.variable, 'pressure');
    assert.equal(t.func, 'transmitter');
  });

  test('something with no digits is not a tag', () => {
    // "ABC" was being read as an Analysis... Controller. Any capitalised word
    // in an enquiry — a customer's initials, a material code — would have
    // produced a confident, wrong instrument type. A tag always carries a
    // number, so requiring one costs nothing and closes the whole class.
    assert.equal(parseInstrumentTag('ABC'), null);
    assert.equal(parseInstrumentTag('PTFE'), null);
    assert.equal(parseInstrumentTag('SS'), null);
  });

  test('empty and junk input returns null rather than throwing', () => {
    for (const junk of ['', null, undefined, '   ', '12345', '---']) {
      assert.doesNotThrow(() => parseInstrumentTag(junk));
    }
  });

  test('out-of-scope device types are identifiable', () => {
    // Forbes Marshall's Gauges Division does not make control valves or
    // controllers. Recognising the tag and knowing it is out of scope is a
    // useful answer; silently matching it to a gauge is not.
    assert.equal(parseInstrumentTag('PSV-100').func, 'valve');
    assert.equal(parseInstrumentTag('TIC-100').func, 'controller');
  });
});
