// server/src/services/categoryAliases.js
//
// Deterministic synonym table for category detection. This is the data-
// driven fix for "the customer didn't use the exact words in our category
// label" (e.g. "RTD sensor", "resistance thermometer", "PT100" should all
// resolve to the `rtd` category) — maintained as plain data here, not
// something a model needs to learn or be fine-tuned on. Extend this list
// whenever a real enquiry uses a term that doesn't resolve.
//
// detectCategory() in parseEnquiryText.js checks these FIRST (cheap, exact,
// instant). Only when nothing here or in the category label matches does
// matchEnquiry.js fall back to an LLM classification constrained to the
// real category id list (categoryClassifier.js) — never a model guessing
// freely.

const CATEGORY_ALIASES = {
  pressure_gauge: ['pressure gauge', 'bourdon gauge', 'dial gauge', 'pressure dial', 'pg'],
  pressure_transmitter: ['pressure transmitter', '4-20ma pressure', 'pressure transducer'],
  smart_pressure_transmitter: ['smart pressure transmitter', 'hart pressure transmitter', 'modbus pressure transmitter', 'smart transmitter'],
  smart_dp_transmitter: ['dp transmitter', 'differential pressure transmitter', 'smart dp transmitter'],
  pressure_switch: ['pressure switch', 'pressure snap switch', 'pressure cutoff', 'high pressure switch', 'low pressure switch'],
  dp_switch: ['dp switch', 'differential pressure switch'],
  temp_transmitter: ['temperature transmitter', 'temp transmitter', 'rtd transmitter', 'thermocouple transmitter', 'tc transmitter'],
  temp_switch: ['temperature switch', 'temp switch', 'thermostat switch', 'high temp switch'],
  temperature_gauge: ['temperature gauge', 'temp gauge', 'dial thermometer', 'bimetal thermometer', 'bimetallic thermometer'],
  level_gauge: ['level gauge', 'level indicator (visual)', 'visual level indicator', 'magnetic level gauge', 'reflex gauge', 'transparent gauge', 'lg'],
  level_switch: ['level switch', 'float switch', 'level cutoff', 'high level switch', 'low level switch'],
  rtd: ['rtd', 'resistance thermometer', 'resistance temperature detector', 'pt100', 'pt-100', 'rtd sensor', 'rtd probe', 'rtd element'],
  indicator: ['process indicator', 'loop powered indicator', 'loop-powered indicator', 'digital indicator', 'field indicator', '4-20ma indicator', 'local display'],
};

module.exports = { CATEGORY_ALIASES };