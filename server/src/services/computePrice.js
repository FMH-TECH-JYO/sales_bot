// server/src/services/computePrice.js
//
// The single place a price is calculated. Everything that shows or stores a
// price goes through priceFor() so the offer document, the configurator screen
// and any future API can never disagree.
//
//   unit_price = products.base_price
//              + SUM(price_delta of every selected order-code option)
//              + price_delta of the selected range row
//
// Why it is computed and not stored: 18 of the 29 catalogue products are
// configurable, and the options are price-bearing (SS316 vs Monel vs
// Hastelloy C, six cable-entry types, three connection sizes...). The WP
// switch alone has 5,184 segment combinations, so "the price of a WP" is not
// a number — only "the price of THIS configuration of a WP" is.
//
// Prices are mock/absent until the admin price upload lands. A product with no
// base_price returns priced:false rather than 0, so the offer document can
// print "As per Annexure" (which the real Forbes Marshall offers already do)
// instead of quoting a confident and wrong zero.

const db = require('../config/db');

/**
 * @param {string} productId
 * @param {object} [config] selected order-code options, { [segment_no]: option_code }
 * @param {string} [rangeCode] code from product_range_tables, when the family has a range table
 * @returns {Promise<{priced: boolean, basePrice: number|null, optionsTotal: number,
 *                    rangeDelta: number, unitPrice: number|null, currency: string,
 *                    breakdown: Array<{label: string, amount: number}>}>}
 */
async function priceFor(productId, config = {}, rangeCode = null) {
  const { rows: productRows } = await db.query(
    'SELECT id, base_price, price_currency FROM products WHERE id = $1',
    [productId]
  );
  if (!productRows.length) throw new Error(`Unknown product "${productId}"`);
  const product = productRows[0];
  const currency = product.price_currency || 'INR';

  const breakdown = [];
  let optionsTotal = 0;
  let rangeDelta = 0;

  const pairs = Object.entries(config || {}).filter(([, code]) => code !== null && code !== undefined && code !== '');
  if (pairs.length) {
    // One query, not one per segment — a configurator recomputes on every
    // dropdown change and this sits directly in that interaction.
    const { rows } = await db.query(
      `SELECT segment_no, option_code, option_label, parameter, COALESCE(price_delta, 0) AS price_delta
         FROM product_order_code_segments
        WHERE product_id = $1
          AND (segment_no, option_code) IN (${pairs.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(', ')})`,
      [productId, ...pairs.flatMap(([seg, code]) => [String(seg), String(code)])]
    );
    for (const row of rows) {
      const delta = Number(row.price_delta) || 0;
      optionsTotal += delta;
      if (delta !== 0) breakdown.push({ label: `${row.parameter}: ${row.option_label}`, amount: delta });
    }
  }

  if (rangeCode) {
    const { rows } = await db.query(
      `SELECT range_text, COALESCE(price_delta, 0) AS price_delta
         FROM product_range_tables
        WHERE product_id = $1 AND code = $2
        LIMIT 1`,
      [productId, String(rangeCode)]
    );
    if (rows.length) {
      rangeDelta = Number(rows[0].price_delta) || 0;
      if (rangeDelta !== 0) breakdown.push({ label: `Range: ${rows[0].range_text}`, amount: rangeDelta });
    }
  }

  const basePrice = product.base_price === null || product.base_price === undefined
    ? null
    : Number(product.base_price);

  if (basePrice === null) {
    return { priced: false, basePrice: null, optionsTotal, rangeDelta, unitPrice: null, currency, breakdown };
  }

  breakdown.unshift({ label: 'Base price', amount: basePrice });
  return {
    priced: true,
    basePrice,
    optionsTotal,
    rangeDelta,
    unitPrice: basePrice + optionsTotal + rangeDelta,
    currency,
    breakdown,
  };
}

/**
 * Line total after a per-line discount. Returns null when the item is unpriced,
 * so callers print "As per Annexure" rather than a fabricated figure.
 */
function lineTotal(unitPrice, qty = 1, discountPct = 0) {
  if (unitPrice === null || unitPrice === undefined) return null;
  const gross = Number(unitPrice) * Number(qty || 1);
  const discount = gross * (Number(discountPct || 0) / 100);
  return Math.round((gross - discount) * 100) / 100;
}

module.exports = { priceFor, lineTotal };
