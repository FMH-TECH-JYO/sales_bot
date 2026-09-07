// web/src/lib/offerPdf.js
//
// Generates a real, downloadable PDF for the offer — no print dialog, a
// genuine file written via jsPDF. Uses the brand's primary colour
// (#323C8A, extracted from the Brand Communications Toolbox) and the real
// logo (embedded as base64, since jsPDF can't reference external image
// files at runtime).
//
// Font note: jsPDF ships only Helvetica/Times/Courier by default. The
// brand's digital font is Roboto (see index.css), but embedding a custom
// TTF into jsPDF requires converting it through jsPDF's font-converter
// tool first — a reasonable follow-up, not done here. Helvetica is the
// closest built-in match and is what's used below.

import { jsPDF } from 'jspdf';

// NOTE ON THE LOGO: the icon mark is deliberately NOT embedded as a raster
// image here. Multiple embedding approaches (PNG with alpha, flattened PNG,
// pre-resized PNG, JPEG) all produced the same rendering artifact — solid
// white blocks appearing near the image — even though every source file
// verified clean under direct inspection and via PIL compositing. This
// points to a jsPDF-internal image-handling issue, not a bad asset. Given
// diminishing returns chasing it, the PDF header uses jsPDF's plain text API
// instead (proven reliable) — a bold "FORBES MARSHALL" wordmark in white on
// the brand navy, no icon. The full logo (icon + wordmark) still renders
// correctly everywhere in the on-screen app (TopBar, LoginPage) — this
// only affects the generated PDF.

const NAVY = [50, 60, 138];      // #323C8A
const INK = [21, 34, 51];
const SUB = [91, 107, 125];
const LINE = [215, 222, 229];
const GOOD_BG = [234, 243, 236];
const GOOD_TX = [31, 122, 77];
const WARN_BG = [252, 239, 221];
const WARN_TX = [154, 91, 20];

/**
 * @param {object} params
 * @param {object} params.product - matched product (model, family, blurb, etc.)
 * @param {number} params.percent - match percentage
 * @param {Array}  params.deviations - [{type, text}]
 * @param {object} params.customer - { company, contact, email }
 * @param {object} params.offer - { version, quantity, specialRequirement, notes: [{version, field, from, to}] }
 * @param {string} params.offerRef
 */
export function generateOfferPdf({ product, percent, deviations, customer, offer, offerRef }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 48;
  let y = 0;

  // --- Header band ---
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, pageW, 86, 'F');
  try {
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.text('FORBES MARSHALL', margin, 45);
  } catch (e) {
    // Should never happen — text rendering is jsPDF's most basic, reliable path.
    console.error('Offer PDF header text failed to render:', e);
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('Commercial Offer', pageW - margin, 50, { align: 'right' });

  y = 116;

  // --- Meta row ---
  doc.setTextColor(...SUB);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text('OFFER REFERENCE', margin, y);
  doc.text('DATE', margin + 200, y);
  doc.text('VALIDITY', margin + 340, y);
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(offerRef, margin, y + 16);
  doc.text(new Date().toLocaleDateString(), margin + 200, y + 16);
  doc.text('30 days', margin + 340, y + 16);

  y += 40;
  doc.setDrawColor(...LINE);
  doc.line(margin, y, pageW - margin, y);
  y += 24;

  // --- Customer ---
  doc.setTextColor(...NAVY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('CUSTOMER', margin, y);
  y += 16;
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Company: ${customer.company || '—'}`, margin, y);
  doc.text(`Contact: ${customer.contact || '—'}`, margin + 220, y);
  y += 15;
  doc.text(`Email: ${customer.email || '—'}`, margin, y);
  y += 30;

  // --- Line item table ---
  doc.setFillColor(...NAVY);
  doc.rect(margin, y, pageW - margin * 2, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('MODEL', margin + 8, y + 15);
  doc.text('DESCRIPTION', margin + 100, y + 15);
  doc.text('QTY', margin + 380, y + 15);
  doc.text('MATCH', margin + 430, y + 15);
  y += 22;

  const rowH = 42;
  doc.setDrawColor(...LINE);
  doc.rect(margin, y, pageW - margin * 2, rowH);
  doc.setTextColor(...INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(product.model, margin + 8, y + 17);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  const descLines = doc.splitTextToSize(`${product.family} — ${product.blurb}`, 260);
  doc.text(descLines.slice(0, 2), margin + 100, y + 14);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(String(offer.quantity || 1), margin + 380, y + 22);
  doc.text(`${percent}%`, margin + 430, y + 22);
  y += rowH + 24;

  // --- Special requirement (the "specific field" a correction updates) ---
  if (offer.specialRequirement) {
    doc.setTextColor(...NAVY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text('SPECIAL REQUIREMENT', margin, y);
    y += 14;
    doc.setTextColor(...INK);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const reqLines = doc.splitTextToSize(offer.specialRequirement, pageW - margin * 2);
    doc.text(reqLines, margin, y);
    y += reqLines.length * 13 + 16;
  }

  // --- Scope clarifications (deviations) ---
  if (deviations.length > 0) {
    doc.setFillColor(...WARN_BG);
    const boxH = 18 + deviations.length * 13;
    doc.roundedRect(margin, y, pageW - margin * 2, boxH, 3, 3, 'F');
    doc.setTextColor(...WARN_TX);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.text('SCOPE CLARIFICATIONS', margin + 10, y + 14);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    deviations.forEach((d, i) => {
      doc.text(`• ${d.text}`, margin + 10, y + 28 + i * 13, { maxWidth: pageW - margin * 2 - 20 });
    });
    y += boxH + 18;
  }

  // --- Revision notes ---
  if (offer.notes && offer.notes.length > 0) {
    doc.setTextColor(...NAVY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text('REVISION NOTES', margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    offer.notes.forEach((n) => {
      const line = `v${n.version} — ${n.field}: "${n.from || '(empty)'}" → "${n.to}"`;
      const wrapped = doc.splitTextToSize(line, pageW - margin * 2);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 12 + 4;
    });
    y += 12;
  }

  // --- Terms ---
  doc.setTextColor(...NAVY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('COMMERCIAL TERMS', margin, y);
  y += 14;
  doc.setTextColor(...SUB);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text('Payment: 30 days net · Delivery: as per standard lead time · Prices exclusive of applicable taxes.', margin, y);
  y += 30;

  // --- Footer note ---
  doc.setDrawColor(...LINE);
  doc.line(margin, y, pageW - margin, y);
  y += 16;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(...SUB);
  const footNote = `This offer was generated from an automated product match (${percent}%) — please confirm the scope clarifications above against your exact application before ordering.`;
  doc.text(doc.splitTextToSize(footNote, pageW - margin * 2), margin, y);

  doc.save(`${offerRef}.pdf`);
}
