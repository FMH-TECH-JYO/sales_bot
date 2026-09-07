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
  },
  required: ['family', 'blurb', 'output_type', 'hazardous'],
};

module.exports = { productDraftSchema };