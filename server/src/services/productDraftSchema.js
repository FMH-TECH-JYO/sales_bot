// server/src/services/productDraftSchema.js
//
// The JSON schema Ollama enforces via its `format` parameter (grammar-
// constrained decoding — the model literally cannot emit a token that would
// break this shape). Kept intentionally FLAT: nested JSON 3+ levels deep is
// a documented failure point for small quantized models. Every field is
// nullable — the model must never guess a number it has no evidence for.

const productDraftSchema = {
  type: 'object',
  properties: {
    id: {
      type: ['string', 'null'],
      description: 'Short model/product code exactly as printed on the datasheet, e.g. "WP", "FMPT-7000". Null if genuinely not stated.',
    },
    model: { type: ['string', 'null'] },
    family: {
      type: 'string',
      description: 'Full product name, e.g. "Weatherproof Pressure Switch"',
    },
    blurb: {
      type: 'string',
      description: 'One or two sentence summary of what the product is and its primary use case, in your own words based on the text.',
    },
    val_min: { type: ['number', 'null'], description: 'Lowest value of the measurement range' },
    val_max: { type: ['number', 'null'], description: 'Highest value of the measurement range' },
    range_unit: { type: ['string', 'null'], description: 'Unit as written, e.g. "bar", "kg/cm2", "mmWC" — do not convert' },
    temp_max: { type: ['number', 'null'], description: 'Maximum process or ambient temperature in Celsius' },
    accuracy: { type: ['string', 'null'] },
    output_type: {
      type: 'string',
      enum: ['switch', '4-20mA', 'hart', 'modbus', 'visual'],
      description: 'switch = mechanical on/off contact; visual = gauge/indicator with no electrical output',
    },
    hazardous: {
      type: 'string',
      enum: ['safe', 'flameproof', 'both'],
      description: '"both" only if the text explicitly offers both a safe-area and an Ex/flameproof/explosion-proof variant',
    },
    connection: { type: ['string', 'null'], description: 'Process connection, e.g. "1/4 NPT (F)"' },
    industries: {
      type: 'array',
      items: { type: 'string' },
      description: 'Industries/applications listed in the text, as short labels',
    },
    // This is the product's FULL specification table, and it is what gets
    // printed in the techno-commercial offer the customer receives.
    //
    // It previously read "any OTHER attribute ... that matters for SELECTING
    // this product" and "leave empty if the text has nothing beyond the fixed
    // fields" — tuned for matching. The result: 51 rows across all 29
    // catalogue products, under two each, while a real Forbes Marshall offer
    // prints ~28 rows for one pressure gauge (Dial, Casing & Bezel Material,
    // Movement material, Case Filling, Lens Material, Pointer, Sealing Ring,
    // Blow Out Disc, Vent Plug...). The offer document defines what this
    // field must hold, not the matcher.
    //
    // Array ORDER is meaningful: it is the print order of the offer's spec
    // table, carried through to product_extra_spec.sort_order on publish.
    extra_specs: {
      type: 'array',
      items: { type: 'string' },
      description: 'The COMPLETE specification table for this product, exactly as printed on the datasheet and in the same order it appears there. Include EVERY specification row you can see — construction materials, dimensions, finishes, seals, fittings, electrical details, reference standards, certifications and options — not only the ones that seem important for selection. Include rows that repeat a field above (Model, Range, Process Connection, Accuracy): this list is printed verbatim in the customer offer, so it has to stand on its own. Each entry MUST be formatted exactly as "Label: Value", one row per entry, keeping the datasheet\'s own wording for both label and value. Examples: "Dial: Aluminium, white background with black numerals", "Casing & Bezel Material: SS 304, bayonet type bezel, weatherproof to IP65", "Blow Out Disc: Neoprene", "Sheath Length: 1450mm (Insertion) + 50mm (for adj. gland)". Copy only what the text actually states — never invent a row to fill a gap, and never merge two rows into one.',
    },
  },
  required: ['family', 'blurb', 'output_type', 'hazardous'],
};

module.exports = { productDraftSchema };