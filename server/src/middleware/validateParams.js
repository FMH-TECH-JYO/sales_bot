// server/src/middleware/validateParams.js
//
// Shape checks for path parameters, so a client's malformed URL is a 400 at
// the edge rather than a Postgres type error reported as a 500.
//
// Without numericParam, GET /enquiries/notanumber reached Postgres as
// `WHERE id = 'notanumber'`, raised 22P02 invalid_input_syntax, and surfaced
// as a 500. Two things are wrong with that: a client mistake is reported as a
// server fault, so it pollutes error monitoring and pages whoever is on call;
// and before the error handler was fixed, the raw Postgres message went back
// to the caller.
//
// IMPORTANT — not every id in this schema is a number.
//
//   integer:  users.id, enquiries.id, catalogue_uploads.id, offers.id,
//             matches.id, enquiry_line_items.id
//   text:     products.id  — and therefore every product_id column
//
// products.id holds the model code: 'FMLG-BM', 'FMDPT-6000', 'FD'. Applying
// numericParam to /products/:id rejects every real product with a 400, which
// is why productCode() exists as a separate check rather than one validator
// used everywhere. Confirm the column type before adding either to a route.

/** Reject a path parameter that is not a positive Postgres INTEGER. */
function numericParam(...names) {
  return function validateNumeric(req, res, next) {
    for (const name of names) {
      const raw = req.params[name];
      if (raw === undefined) continue;

      // Not parseInt — parseInt('12abc') is 12, which would silently accept a
      // malformed URL and look up the wrong record.
      if (!/^\d+$/.test(raw)) {
        return next(badRequest(`"${name}" must be a positive integer.`));
      }
      const value = Number(raw);
      // Past 2^31-1 a Postgres INTEGER column raises 22003 out-of-range,
      // which would be another spurious 500.
      if (!Number.isSafeInteger(value) || value > 2147483647 || value < 1) {
        return next(badRequest(`"${name}" is out of range.`));
      }
      req.params[name] = String(value);
    }
    next();
  };
}

// Model codes as they actually appear in products.id: letters, digits, hyphen,
// underscore, dot, slash and space. Deliberately permissive about the alphabet
// and strict about length and about characters that have no business in a
// model code — control characters, quotes, angle brackets, percent signs.
const PRODUCT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/;

/**
 * Reject a path parameter that cannot be a product code.
 *
 * This is not what prevents SQL injection — every query in this app is
 * parameterised, which is. It stops a malformed or absurdly long value from
 * reaching a controller and becoming a confusing 404 or a slow scan.
 */
function productCode(...names) {
  return function validateProductCode(req, res, next) {
    for (const name of names) {
      const raw = req.params[name];
      if (raw === undefined) continue;
      if (typeof raw !== 'string' || !PRODUCT_CODE_RE.test(raw)) {
        return next(badRequest(`"${name}" is not a valid product code.`));
      }
    }
    next();
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_PARAMETER';
  return err;
}

module.exports = { numericParam, productCode, PRODUCT_CODE_RE };
