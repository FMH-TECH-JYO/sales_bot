// web/src/pages/MatchingPage.jsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { api } from '../api';
import TopBar from '../components/TopBar';

function MatchBadge({ percent, band }) {
  const color = band === 'strong' ? 'var(--fm-success)' : band === 'workable' ? 'var(--fm-warning)' : 'var(--fm-danger)';
  return (
    <div className="match-badge" style={{ borderColor: color }}>
      <div className="match-badge-pct" style={{ color }}>{percent}%</div>
      <div className="match-badge-label">Overall Match</div>
    </div>
  );
}

export default function MatchingPage() {
  const { enquiry, setEnquiry, setOffer } = useApp();
  const navigate = useNavigate();

  if (!enquiry || !enquiry.results?.length) {
    return (
      <div className="chat-shell">
        <TopBar title="Product Match" />
        <div className="empty-state">
          <p>No enquiry in progress.</p>
          <button className="primary-btn" onClick={() => navigate('/chat')}>Start a new enquiry</button>
        </div>
      </div>
    );
  }

  const selected = enquiry.results[enquiry.selectedIndex];
  const p = selected.product;

  function selectAlternative(idx) {
    setEnquiry({ ...enquiry, selectedIndex: idx });
  }

  /** Fully restart, exactly like relaunching the chatbot — clears the working
   * enquiry AND any offer draft. The conversation stays in "Recent" history
   * (that's expected chatbot behaviour: old chats persist, this just starts
   * a fresh one), but nothing about it carries into the new session. */
  function handleReset() {
    setEnquiry(null);
    setOffer(null);
    navigate('/chat');
  }

  /** Edit re-opens the SAME conversation, editable — enquiry is deliberately
   * left in context (not cleared) so ChatPage prefills from it. */
  function handleEdit() {
    navigate('/chat');
  }

  function handleProceed() {
    navigate('/offer');
  }

  return (
    <div className="chat-shell">
      <TopBar title="Product Match" />
      <div className="match-page">
        <div className="match-summary-bar">
          <div>
            <div className="hint">Your enquiry</div>
            <div className="match-enquiry-text">"{enquiry.text}"</div>
          </div>
        </div>

        <div className="match-top">
          <div className="match-primary-card panel">
            <div className="match-primary-head">
              <div>
                <div className="match-product-model">{p.model}</div>
                <div className="match-product-family">{p.family}</div>
                <div className="hint">Source: {p.category_label} catalogue{enquiry.provider ? ` · matched by ${enquiry.provider}` : ''}</div>
              </div>
              <MatchBadge percent={selected.percent} band={selected.band} />
            </div>

            <p className="match-blurb">{p.blurb}</p>
            {selected.reason && <p className="hint" style={{ marginTop: -8, marginBottom: 12 }}><strong>Why this product:</strong> {selected.reason}</p>}

            <div className="spec-compare">
              <div className="spec-compare-col">
                <h4>Enquiry requirement</h4>
                <ul>
                  <li>Range: {enquiry.parsed.range ? `${enquiry.parsed.range.min} to ${enquiry.parsed.range.max}` : 'not specified'}</li>
                  <li>Max temp: {enquiry.parsed.tempMax != null ? `${enquiry.parsed.tempMax}°C` : 'not specified'}</li>
                  <li>Area: {enquiry.parsed.hazardous || 'not specified'}</li>
                  <li>Output: {enquiry.parsed.outputCandidates.length ? enquiry.parsed.outputCandidates.join(', ') : 'not specified'}</li>
                </ul>
              </div>
              <div className="spec-compare-col">
                <h4>Product specification</h4>
                <ul>
                  <li>Range: {p.val_min} to {p.val_max}</li>
                  <li>Max temp: {p.temp_max}°C</li>
                  <li>Area: {p.hazardous}</li>
                  <li>Output: {p.output_type}</li>
                  <li>Accuracy: {p.accuracy || '—'}</li>
                  <li>Connection: {p.connection || '—'}</li>
                </ul>
              </div>
            </div>

            {selected.matchingSpecs.length > 0 && (
              <div className="match-list match-list-good">
                <h4>✓ Matching specifications</h4>
                <ul>{selected.matchingSpecs.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            {selected.deviations.length > 0 && (
              <div className="match-list match-list-warn">
                <h4>⚠ Deviations</h4>
                <ul>{selected.deviations.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
            )}
            {selected.missingSpecs?.length > 0 && (
              <div className="match-list match-list-warn">
                <h4>? Missing / unconfirmed specifications</h4>
                <ul>{selected.missingSpecs.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
            )}

            {p.has_catalogue ? (
              <a className="catalogue-card" href={api.catalogueUrl(p.id)} target="_blank" rel="noreferrer">
                <span className="catalogue-icon">📄</span>
                <div className="catalogue-info">
                  <div className="catalogue-name">{p.model} — Datasheet</div>
                  <div className="catalogue-meta">PDF · view or download</div>
                </div>
                <span className="catalogue-action">View Catalogue ↗</span>
              </a>
            ) : (
              <div className="catalogue-card catalogue-card-unavailable">
                <span className="catalogue-icon">📄</span>
                <div className="catalogue-info">
                  <div className="catalogue-name">{p.model} — Datasheet</div>
                  <div className="catalogue-meta">Not yet uploaded to the catalogue library</div>
                </div>
              </div>
            )}
          </div>

          <div className="match-alternatives panel">
            <h4>Other matches</h4>
            {enquiry.results.slice(0, 6).map((r, i) => (
              <div
                key={r.product.id}
                className={`alt-row ${i === enquiry.selectedIndex ? 'alt-row-selected' : ''}`}
                onClick={() => selectAlternative(i)}
              >
                <div>
                  <div className="alt-model">{r.product.model}</div>
                  <div className="alt-family">{r.product.family}</div>
                </div>
                <div className="alt-pct" style={{ color: r.band === 'strong' ? 'var(--fm-success)' : r.band === 'workable' ? 'var(--fm-warning)' : 'var(--fm-danger)' }}>
                  {r.percent}%
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="match-footer">
          <button className="secondary-btn" onClick={handleReset}>Reset</button>
          <button className="secondary-btn" onClick={handleEdit}>Edit</button>
          <button className="primary-btn" onClick={handleProceed}>Proceed with Offer Generation</button>
        </div>
      </div>
    </div>
  );
}
