// web/src/pages/OfferPage.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import TopBar from '../components/TopBar';
import { generateOfferPdf } from '../lib/offerPdf';
import { api } from '../api';

const DEFAULT_OFFER = { version: 1, quantity: 1, specialRequirement: '', notes: [] };

// Turns a snake_case placeholder tag like "bourdon_socket1" into a readable
// label for the form: "Bourdon Socket 1". Purely cosmetic — the actual key
// sent back to the server is always the raw tag name.
function labelFor(tag) {
  return tag.replace(/_/g, ' ').replace(/(\d+)$/, ' $1').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export default function OfferPage() {
  const { enquiry, offer, setOffer } = useApp();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(offer || DEFAULT_OFFER);
  const [customer, setCustomer] = useState({ company: '', contact: '', email: '' });
  const [generating, setGenerating] = useState(false);

  // Real .docx template wiring: fetch which placeholders THIS product's
  // category template actually needs (read live from the file server-side,
  // nothing hardcoded here), let the sales engineer fill in what the
  // catalogue doesn't already know, then render + download the real file.
  const [templateStatus, setTemplateStatus] = useState('loading'); // loading | ready | none
  const [manualFields, setManualFields] = useState([]);
  const [manualValues, setManualValues] = useState({});
  const [docxError, setDocxError] = useState(null);

  const p0 = enquiry?.results?.[enquiry.selectedIndex]?.product;

  useEffect(() => {
    if (!p0) return;
    setTemplateStatus('loading');
    api
      .getOfferFields(p0.id)
      .then(({ manualFields: fields }) => {
        setManualFields(fields);
        setManualValues(Object.fromEntries(fields.map((f) => [f, ''])));
        setTemplateStatus('ready');
      })
      .catch(() => setTemplateStatus('none'));
  }, [p0?.id]);

  if (!enquiry || !enquiry.results?.length) {
    return (
      <div className="chat-shell">
        <TopBar title="Offer" />
        <div className="empty-state">
          <p>No matched product to generate an offer for.</p>
          <button className="primary-btn" onClick={() => navigate('/chat')}>Start a new enquiry</button>
        </div>
      </div>
    );
  }

  const selected = enquiry.results[enquiry.selectedIndex];
  const p = selected.product;
  const current = offer || DEFAULT_OFFER;
  const offerRef = `OFR-${p.id}-${new Date().getFullYear()}-${String(current.version).padStart(2, '0')}`;

  function handlePdf() {
    setGenerating(true);
    try {
      generateOfferPdf({
        product: p,
        percent: selected.percent,
        deviations: selected.deviations,
        customer,
        offer: current,
        offerRef,
      });
    } finally {
      setGenerating(false);
    }
  }

  function handleDocx() {
    setDocxError(null);
    setGenerating(true);
    api
      .generateOfferDocx({
        productId: p.id,
        customerName: customer.company,
        qty: current.quantity,
        fields: manualValues,
      })
      .then(({ blob, filename }) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      })
      .catch((e) => setDocxError(e.message))
      .finally(() => setGenerating(false));
  }

  /** Regenerate with Correction: diffs `draft` against the last-committed
   * `offer`, updates the SPECIFIC field(s) that changed, and records an
   * explicit before → after entry in Revision Notes — rather than just
   * appending free-text like the previous version did. */
  function handleRegenerate() {
    const notes = [...current.notes];
    const nextVersion = current.version + 1;

    if (String(draft.quantity) !== String(current.quantity)) {
      notes.push({ version: nextVersion, field: 'Quantity', from: current.quantity, to: draft.quantity });
    }
    if (draft.specialRequirement !== current.specialRequirement) {
      notes.push({ version: nextVersion, field: 'Special Requirement', from: current.specialRequirement, to: draft.specialRequirement });
    }

    if (notes.length === current.notes.length) {
      alert('Nothing changed — edit Quantity or Special Requirement above before regenerating.');
      return;
    }

    const updated = { ...draft, version: nextVersion, notes };
    setOffer(updated);
    setDraft(updated);
  }

  return (
    <div className="offer-page-shell">
      <div className="no-print">
        <TopBar title="Offer Generation" />
      </div>

      <div className="offer-toolbar no-print">
        <button className="secondary-btn" onClick={() => navigate('/matching')}>← Back to match</button>
        <div className="offer-toolbar-actions">
          <button className="secondary-btn" onClick={handlePdf} disabled={generating}>
            {generating ? 'Generating…' : '⬇ Download as PDF'}
          </button>
          <button className="secondary-btn offer-docx-btn" onClick={handleDocx} disabled={generating || templateStatus !== 'ready'}
            title={templateStatus === 'none' ? `No offer template uploaded yet for category "${p.category_id}"` : ''}>
            {generating ? 'Generating…' : '⬇ Download as DOCX (real template)'}
          </button>
        </div>
      </div>

      <div className="offer-doc">
        <div className="offer-doc-header">
          <div className="offer-brand">FORBES MARSHALL</div>
          <div className="offer-doc-title">Commercial Offer</div>
        </div>
        <div className="offer-meta-row">
          <div>
            <div className="hint">Offer reference</div>
            <div>{offerRef}{current.version > 1 ? ` (v${current.version})` : ''}</div>
          </div>
          <div>
            <div className="hint">Date</div>
            <div>{new Date().toLocaleDateString()}</div>
          </div>
          <div>
            <div className="hint">Validity</div>
            <div>30 days</div>
          </div>
        </div>

        <div className="offer-customer">
          <h4>Customer</h4>
          <div className="offer-customer-grid">
            <input placeholder="Company name" value={customer.company} onChange={(e) => setCustomer({ ...customer, company: e.target.value })} />
            <input placeholder="Contact person" value={customer.contact} onChange={(e) => setCustomer({ ...customer, contact: e.target.value })} />
            <input placeholder="Email" value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} />
          </div>
        </div>

        <table className="offer-line-table">
          <thead>
            <tr><th>Model</th><th>Description</th><th>Qty</th><th>Match</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>{p.model}</td>
              <td>{p.family} — {p.blurb}</td>
              <td>{current.quantity}</td>
              <td>{selected.percent}%</td>
            </tr>
          </tbody>
        </table>

        {selected.deviations.length > 0 && (
          <div className="offer-scope-notes">
            <h4>Scope clarifications</h4>
            <ul>{selected.deviations.map((d, i) => <li key={i}>{d}</li>)}</ul>
          </div>
        )}

        {docxError && (
          <div className="offer-scope-notes" style={{ borderColor: '#B03327', color: '#B03327' }}>{docxError}</div>
        )}

        {templateStatus === 'ready' && manualFields.length > 0 && (
          <div className="offer-edit-panel no-print">
            <h4>Fields for the {p.category_label || p.category_id} offer template</h4>
            <p className="hint" style={{ marginTop: -4 }}>
              These aren't in the catalogue record yet, so fill them in before downloading the DOCX — everything else
              (model, range, accuracy, connection, temperature, customer, date, qty) is auto-filled from the match above.
            </p>
            <div className="offer-edit-grid">
              {manualFields.map((f) => (
                <div className="field-row" key={f}>
                  <label>{labelFor(f)}</label>
                  <input
                    value={manualValues[f] || ''}
                    onChange={(e) => setManualValues({ ...manualValues, [f]: e.target.value })}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
        {templateStatus === 'none' && (
          <p className="hint">No offer template has been uploaded yet for the "{p.category_label || p.category_id}" category — DOCX download isn't available for this product yet; use "Download as PDF" instead.</p>
        )}

        {/* Editable fields — this is what "Regenerate with Correction" actually
            updates. Structured fields, not freeform chat text, so the change
            is unambiguous and traceable in Revision Notes below. */}
        <div className="offer-edit-panel no-print">
          <h4>Adjust this offer</h4>
          <div className="offer-edit-grid">
            <div className="field-row">
              <label>Quantity</label>
              <input type="number" min="1" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
            </div>
            <div className="field-row full">
              <label>Special requirement (materials, delivery, custom scope…)</label>
              <textarea rows={2} value={draft.specialRequirement} onChange={(e) => setDraft({ ...draft, specialRequirement: e.target.value })} />
            </div>
          </div>
          <button className="primary-btn" onClick={handleRegenerate}>Regenerate with Correction</button>
        </div>

        {current.specialRequirement && (
          <div className="offer-scope-notes">
            <h4>Special requirement</h4>
            <p style={{ margin: 0, fontSize: 13.5 }}>{current.specialRequirement}</p>
          </div>
        )}

        {current.notes.length > 0 && (
          <div className="offer-scope-notes">
            <h4>Revision notes</h4>
            <ul>
              {current.notes.map((n, i) => (
                <li key={i}><strong>v{n.version} — {n.field}:</strong> "{n.from || '(empty)'}" → "{n.to}"</li>
              ))}
            </ul>
          </div>
        )}

        <div className="offer-terms">
          <h4>Commercial terms</h4>
          <p>Payment: 30 days net · Delivery: as per standard lead time · Prices exclusive of applicable taxes.</p>
        </div>

        <div className="offer-footer-note">
          This offer was generated from an automated product match ({selected.percent}%) — please confirm the
          scope clarifications above against your exact application before ordering.
        </div>
      </div>
    </div>
  );
}
