// server/test/generateOffer.test.js
//
// The offer is the only document in this system a CUSTOMER ever reads. It goes
// out on company letterhead with a price on it. Everything here is about what
// must never appear on that page.
//
// The bug this file was written for: rendering a real offer with a partially
// filled form produced
//
//     Kind Attn : undefined
//     Reference standard   -   undefined
//     Dial Size            -   undefined
//
// and eleven more rows the same. docxtemplater's default nullGetter returns
// the string "undefined" for a tag it cannot resolve. renderOffer() had a
// Proxy that was meant to prevent exactly this and never did: docxtemplater
// resolves a tag by asking whether the scope HAS the key, and a Proxy with
// only a `get` trap answers that from the target, so a missing key was
// reported absent and the default nullGetter ran regardless.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  hasTemplate, listPlaceholders, renderOffer, autoFillFromProduct, matchExtraSpecsToTags,
} = require('../src/services/generateOffer');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'offers');
const CATEGORY = 'pressure_gauge';

/** Read every piece of text out of a generated .docx, body and tables alike. */
function textOf(buffer) {
  const PizZip = require('pizzip');
  const zip = new PizZip(buffer);
  const xml = zip.file('word/document.xml').asText();
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('offer template', () => {
  test('the common template is present', () => {
    // Without this file every offer request answers "No offer template
    // uploaded yet" and the enquiry-to-offer flow stops one step from the end.
    const file = path.join(TEMPLATES_DIR, 'pressure_gauge.docx');
    assert.ok(fs.existsSync(file), `missing ${file} — see that directory's README`);
    assert.ok(fs.statSync(file).size > 10_000, 'the template is suspiciously small');
  });

  test('every category falls back to the common template', () => {
    for (const category of ['pressure_gauge', 'level_gauge', 'dp_switch', 'smart_dp_transmitter', 'anything_new']) {
      assert.equal(hasTemplate(category), true, `no template resolved for ${category}`);
    }
  });

  test('the placeholders the template declares are the ones the code fills', () => {
    const tags = listPlaceholders(CATEGORY);
    // These six are filled straight from the products row by
    // autoFillFromProduct(). If a template rename breaks one, the sales
    // engineer is silently asked to retype something the catalogue knows.
    for (const required of ['model1', 'range1', 'accuracy1', 'connection1', 'process_temperature1', 'qty1']) {
      assert.ok(tags.includes(required), `template no longer contains {{${required}}}`);
    }
    for (const required of ['offer_no', 'date', 'customer_name', 'subject']) {
      assert.ok(tags.includes(required), `template no longer contains {{${required}}}`);
    }
  });
});

describe('renderOffer', () => {
  const FULL = {
    offer_no: 'FMH/2026/0417',
    date: '10/09/2026',
    customer_name: 'Bharat Petroleum Corporation Ltd',
    subject: 'Pressure Gauges',
    model1: 'SP',
    range1: '0 to 10 kg/cm2',
    qty1: '5',
  };

  test('renders a document and substitutes the values given', () => {
    const text = textOf(renderOffer(CATEGORY, FULL));
    assert.match(text, /FMH\/2026\/0417/);
    assert.match(text, /Bharat Petroleum Corporation Ltd/);
    assert.match(text, /0 to 10 kg\/cm2/);
  });

  test('NO tag is left unrendered — no {{ }} reaches the customer', () => {
    const text = textOf(renderOffer(CATEGORY, FULL));
    const leftover = text.match(/\{\{\s*\w+\s*\}\}/g);
    assert.equal(leftover, null, `unrendered tags on a customer document: ${leftover}`);
  });

  test('a tag with no value renders EMPTY, never the word "undefined"', () => {
    // The defect this file exists for.
    const text = textOf(renderOffer(CATEGORY, FULL));
    assert.equal(/\bundefined\b/.test(text), false,
      'the literal string "undefined" appears on a customer-facing offer');
  });

  test('null and undefined values render empty, never "null"', () => {
    const text = textOf(renderOffer(CATEGORY, {
      ...FULL, kind_attn: null, attn_name: undefined, dial_size1: null,
    }));
    assert.equal(/\bundefined\b/.test(text), false);
    assert.equal(/\bnull\b/.test(text), false, '"null" appears on a customer-facing offer');
  });

  test('rendering with NO data at all still produces a clean document', () => {
    // The worst case: every field blank. It must produce an empty-but-correct
    // letter, not a page of "undefined".
    const text = textOf(renderOffer(CATEGORY, {}));
    assert.equal(/\bundefined\b/.test(text), false);
    assert.equal(/\{\{/.test(text), false);
    // The company's own boilerplate must survive — this is still their letter.
    assert.match(text, /Forbes Marshall/i);
  });

  test('numbers are rendered, not dropped', () => {
    // A quantity of 5 arriving as the number 5 rather than "5" must still print.
    const text = textOf(renderOffer(CATEGORY, { ...FULL, qty1: 5, unit_price1: 1450 }));
    assert.match(text, /1450/);
  });

  test('the official letterhead and commercial terms are preserved', () => {
    // The whole point of building the template FROM Format.docx: the layout,
    // branding and terms are the company's, untouched.
    const text = textOf(renderOffer(CATEGORY, FULL));
    assert.match(text, /Gauges Division/i);
    assert.match(text, /Commercial terms/i);
    assert.match(text, /Payment Terms/i);
    assert.match(text, /Warranty/i);
  });
});

describe('autoFillFromProduct', () => {
  test('fills what the catalogue knows and stays silent about what it does not', () => {
    const filled = autoFillFromProduct(
      { id: 'SP', model: 'SP', val_min: 0, val_max: 10, accuracy: '±1% FSD', connection: '1/2" NPT', temp_max: 200 },
      { customerName: 'ACME', qty: 5 }
    );
    assert.equal(filled.model1, 'SP');
    assert.equal(filled.range1, '0 to 10');
    assert.equal(filled.accuracy1, '±1% FSD');
    assert.equal(filled.qty1, '5');
    // A product with no dial size must not acquire one.
    assert.equal('dial_size1' in filled, false);
  });

  test('a product with empty columns yields empty strings, not "null to null"', () => {
    const filled = autoFillFromProduct({ id: 'X', model: 'X', val_min: null, val_max: null, temp_max: null }, {});
    assert.equal(filled.range1, '');
    assert.equal(filled.process_temperature1, '');
  });
});

describe('matchExtraSpecsToTags', () => {
  test('matches catalogue spec labels onto template tags across punctuation', () => {
    // The catalogue stores "Dial Size"; the template declares {{dial_size1}}.
    // Both normalise to "dialsize", which is what makes an admin-uploaded
    // datasheet fill the offer instead of the engineer retyping it.
    const tags = ['dial_size1', 'bourdon_socket1', 'case_bezel1', 'over_pressure_limit1'];
    const matched = matchExtraSpecsToTags(tags, [
      { label: 'Dial Size', value: '150 mm' },
      { label: 'Bourdon & Socket', value: 'SS316L' },
      { label: 'Case & Bezel', value: 'SS304' },
      { label: 'Over pressure limit', value: '130% FSD' },
    ]);
    assert.equal(matched.dial_size1, '150 mm');
    assert.equal(matched.bourdon_socket1, 'SS316L');
    assert.equal(matched.case_bezel1, 'SS304');
    assert.equal(matched.over_pressure_limit1, '130% FSD');
  });

  test('an unrelated spec is not forced onto a tag', () => {
    const matched = matchExtraSpecsToTags(['dial_size1'], [{ label: 'Ingress Protection', value: 'IP65' }]);
    assert.equal('dial_size1' in matched, false);
  });
});
