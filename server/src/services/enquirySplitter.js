// Deterministically split a multi-enquiry attachment before matching. This is
// deliberately rules-first for speed and auditability; it handles numbered
// RFQ sections and common spreadsheet-style rows without a second LLM call.
function clean(text) {
  return String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function meaningful(block) {
  return block.length >= 18 && /[a-z]/i.test(block) && (/\d/.test(block) || /\b(pressure|temperature|level|flow|switch|transmitter|gauge|hart|atex|requirement|product)\b/i.test(block));
}

function splitEnquiries(rawText, maxItems = 12) {
  const text = clean(rawText);
  const lines = text.split('\n');
  const marker = /^\s*(?:(?:enquiry|rfq|requirement|item)\s*(?:no\.?|number)?\s*)?(\d+)\s*[).:|-]\s*/i;
  const starts = lines.map((line, index) => marker.test(line) ? index : -1).filter((index) => index >= 0);
  if (starts.length >= 2) {
    const blocks = starts.map((start, index) => clean(lines.slice(start, starts[index + 1] ?? lines.length).join('\n'))).filter(meaningful);
    if (blocks.length >= 2) return blocks.slice(0, maxItems);
  }

  // Excel/CSV extraction preserves rows with `|`. When its header describes
  // an enquiry table, every populated row is an independent enquiry.
  const headerIndex = lines.findIndex((line) => line.includes('|') && /\b(enquiry|requirement|description|product|item)\b/i.test(line));
  if (headerIndex >= 0) {
    const header = lines[headerIndex];
    const rows = lines.slice(headerIndex + 1).filter((line) => line.includes('|') && meaningful(line));
    if (rows.length >= 2) return rows.slice(0, maxItems).map((row) => `${header}\n${row}`);
  }

  return [text];
}

module.exports = { splitEnquiries };
