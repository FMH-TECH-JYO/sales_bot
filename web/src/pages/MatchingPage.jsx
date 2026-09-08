// web/src/pages/MatchingPage.jsx
//
// Shows the match result(s) for the current enquiry. A single uploaded
// Excel/PDF (or a multi-item typed message) can contain several distinct
// product enquiries — enquiry.items is always an array, one entry per
// enquiry the server identified, each with its own independent ranked
// candidate list. When there's only one item, this renders exactly as it
// always did; when there are several, an "Enquiry 1 of N" strip lets the
// reviewer step through them, and each keeps its own selected-alternative
// state.
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

const STATUS_LABEL = {
  match: 'Matches',
  compare: 'Differs',
  missing: 'Not confirmed',
  not_requested: 'Not requested',
};

function RequestedVsActualRow({ row }) {
  return (
    <tr>
      <td>{row.parameter}</td>
      <td>{row.requested ?? '—'}</td>
      <td>{row.actual ?? '—'}</td>
      <td className={`rva-status rva-${row.status}`}>{STATUS_LABEL[row.status] || row.status}</td>
    </tr>
  );
}

export default function MatchingPage() {
  const { enquiry, setEnquiry, setOffer } = useApp();
  const navigate = useNavigate();

  const items = enquiry?.items;
  if (!enquiry || !items?.length) {
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

  const itemIndex = enquiry.selectedItemIndex ?? 0;
  const item = items[itemIndex];
  const hasResults = item.results?.length > 0;
  const selected = hasResults ? item.results[item.selectedIndex ?? 0] : null;
  const p = selected?.product;

  function selectItem(idx) {
    setEnquiry({ ...enquiry, selectedItemIndex: idx });
  }

  function selectAlternative(idx) {
    const updatedItems = items.map((it, i) => (i === itemIndex ? { ...it, selectedIndex: idx } : it));
    setEnquiry({ ...enquiry, items: updatedItems });
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
            <div className="hint">{items.length > 1 ? `Enquiry ${itemIndex + 1} of ${items.length}` : 'Your enquiry'}</div>
            <div className="match-enquiry-text">"{item.sourceExcerpt || item.text}"</div>
            {item.sourceRef && <div className="hint" style={{ marginTop: 4 }}>Source: {item.sourceRef}</div>}
          </div>
        </div>

        {items.length > 1 && (
          <div className="enquiry-tabs">
            {items.map((it, i) => {
              const top = it.results?.[0];
              return (
                <button
                  key={i}
                  className={`enquiry-tab ${i === itemIndex ? 'enquiry-tab-active' : ''}`}
                  onClick={() => selectItem(i)}
                >
                  <span className="enquiry-tab-num">#{i + 1}</span>
                  {top ? (
                    <span className="enquiry-tab-pct" style={{ color: top.band === 'strong' ? 'var(--fm-success)' : top.band === 'workable' ? 'var(--fm-warning)' : 'var(--fm-danger)' }}>
                      {top.percent}%
                    </span>
                  ) : (
                    <span className="enquiry-tab-pct hint">no match</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {item.warning && <div className="error-box">{item.warning}</div>}

        {!hasResults ? (
          <div className="panel empty-state" style={{ padding: 30 }}>
            <p>No candidate products found for this enquiry.</p>
          </div>
        ) : (
        <div className="match-top">
          <div className="match-primary-card panel">
            <div className="match-primary-head">
              <div>
                <div className="match-product-model">{p.model}</div>
                <div className="match-product-family">{p.family}</div>
                <div className="hint">Source: {p.category_label} catalogue{item.provider ? ` · matched by ${item.provider}` : ''}</div>
              </div>
              <MatchBadge percent={selected.percent} band={selected.band} />
            </div>

            <p className="match-blurb">{p.blurb}</p>
            {selected.reason && <p className="hint" style={{ marginTop: -8, marginBottom: 12 }}><strong>Why this product:</strong> {selected.reason}</p>}

            <div className="spec-compare">
              <div className="spec-compare-col">
                <h4>Enquiry requirement</h4>
                <ul>
                  <li>Range: {item.parsed.range ? `${item.parsed.range.min} to ${item.parsed.range.max}` : 'not specified'}</li>
                  <li>Max temp: {item.parsed.tempMax != null ? `${item.parsed.tempMax}°C` : 'not specified'}</li>
                  <li>Area: {item.parsed.hazardous || 'not specified'}</li>
                  <li>Output: {item.parsed.outputCandidates.length ? item.parsed.outputCandidates.join(', ') : 'not specified'}</li>
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

            {selected.requestedVsActual?.length > 0 && (
              <div className="rva-table-wrap">
                <h4>Requested vs actual</h4>
                <table className="rva-table">
                  <thead>
                    <tr><th>Parameter</th><th>Requested</th><th>Actual</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {selected.requestedVsActual.map((row, i) => <RequestedVsActualRow row={row} key={i} />)}
                  </tbody>
                </table>
              </div>
            )}

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

            {selected.webFindings?.length > 0 && (
              <div className="match-list match-list-good">
                <h4>🌐 Found via internet lookup</h4>
                <ul>
                  {selected.webFindings.map((f, i) => (
                    <li key={i}>
                      <strong>{f.spec}:</strong> {f.value}{' '}
                      <a href={f.source.url} target="_blank" rel="noreferrer" className="source-link">[source]</a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {selected.webLookupNote && (
              <p className="hint" style={{ marginTop: 4 }}>{selected.webLookupNote}</p>
            )}

            {selected.sources?.length > 0 && (
              <div className="sources-block">
                <h4>Sources</h4>
                <ul>
                  {selected.sources.map((s, i) => (
                    <li key={i}>
                      {s.type === 'catalogue' ? (
                        <a href={api.catalogueUrl(s.productId)} target="_blank" rel="noreferrer">{s.label}</a>
                      ) : (
                        <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>
                      )}
                      <span className="source-type-chip">{s.type === 'catalogue' ? 'internal catalogue' : 'web'}</span>
                    </li>
                  ))}
                </ul>
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
            {item.results.slice(0, 6).map((r, i) => (
              <div
                key={r.product.id}
                className={`alt-row ${i === (item.selectedIndex ?? 0) ? 'alt-row-selected' : ''}`}
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
        )}

        <div className="match-footer">
          <button className="secondary-btn" onClick={handleReset}>Reset</button>
          <button className="secondary-btn" onClick={handleEdit}>Edit</button>
          <button className="primary-btn" onClick={handleProceed} disabled={!hasResults}>Proceed with Offer Generation</button>
        </div>
      </div>
    </div>
  );
}
