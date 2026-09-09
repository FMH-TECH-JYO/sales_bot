// web/src/pages/EnquiryHistoryPage.jsx
//
// Every enquiry the team has run, with the matches and the deviations exactly
// as the engineer saw them at the time.
//
// This page only became possible with migration 004 + persistEnquiry.js.
// Before that, nothing in the app wrote a row: an enquiry existed only in the
// browser tab that ran it, so there was no history, no demand signal and no way
// to check what was quoted against what was asked for.
//
// The deviations shown here come from matches.deviations_json — a SNAPSHOT
// taken at match time, not a re-computation. The catalogue changes; what was
// shown to the engineer on the day must not.

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TopBar from '../components/TopBar';
import { api } from '../api';

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function bandColor(pct) {
  const n = Number(pct);
  if (n >= 75) return 'var(--fm-success)';
  if (n >= 50) return 'var(--fm-warning)';
  return 'var(--fm-danger)';
}

function SourceChip({ type, quality }) {
  // 'ocr_pdf' means pdfParser found almost no text — a scan. Worth flagging,
  // because until OCR lands those enquiries match on very little.
  const scanned = quality === 'ocr_pdf';
  return (
    <span className="role-chip" title={scanned ? 'Little or no extractable text — likely a scan' : ''}>
      {type || 'text'}{scanned ? ' · scanned' : ''}
    </span>
  );
}

function MatchRow({ m }) {
  const dev = m.deviations_json || {};
  const crit = m.criteria_scores || {};
  const deviations = dev.deviations || [];
  const rva = dev.requestedVsActual || [];
  const missing = crit.missingSpecs || [];

  return (
    <div className="panel" style={{ padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <strong>#{m.rank}</strong>
        <strong>{m.model}</strong>
        <span className="hint">{m.family}</span>
        <span style={{ marginLeft: 'auto', color: bandColor(m.percent_match), fontWeight: 700 }}>
          {Math.round(Number(m.percent_match))}%
        </span>
      </div>

      {crit.reason && <p className="hint" style={{ margin: '6px 0 0' }}>{crit.reason}</p>}

      {rva.length > 0 && (
        <table className="rva-table" style={{ marginTop: 10, width: '100%' }}>
          <thead><tr><th>Parameter</th><th>Requested</th><th>Offered</th></tr></thead>
          <tbody>
            {rva.map((r, i) => (
              <tr key={i}>
                <td>{r.field}</td>
                <td>{r.requested ?? '—'}</td>
                <td>{r.actual ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deviations.length > 0 && (
        <div className="match-list match-list-warn" style={{ marginTop: 10 }}>
          <h4>⚠ Deviations (as shown at match time)</h4>
          <ul>{deviations.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}

      {missing.length > 0 && (
        <div className="match-list match-list-warn" style={{ marginTop: 8 }}>
          <h4>? Missing / unconfirmed</h4>
          <ul>{missing.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function LineItem({ item }) {
  const [open, setOpen] = useState(false);
  const extracted = item.extracted_json || {};
  const parsed = extracted.parsed || {};
  const top = item.matches?.[0];

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <button
        className="link-btn"
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', width: '100%', gap: 12, alignItems: 'center', textAlign: 'left', padding: 12 }}
      >
        <span style={{ fontWeight: 600 }}>{item.tag_no || `Item ${(item.line_index ?? 0) + 1}`}</span>
        <span className="hint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.source_excerpt || '—'}
        </span>
        {top && (
          <span style={{ color: bandColor(top.percent_match), fontWeight: 700 }}>
            {Math.round(Number(top.percent_match))}%
          </span>
        )}
        <span className="hint">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          <div className="hint" style={{ marginBottom: 8 }}>
            {item.source_ref && <>Source: {item.source_ref} · </>}
            {item.category_id && <>Category: {item.category_id} · </>}
            {item.extraction_provider && <>Matched by {item.extraction_provider}</>}
          </div>

          {Object.keys(parsed).length > 0 && (
            <details style={{ marginBottom: 10 }}>
              <summary className="hint">What the pipeline understood from this line</summary>
              <pre style={{ fontSize: 12, overflowX: 'auto', background: 'rgba(0,0,0,.04)', padding: 8, borderRadius: 4 }}>
                {JSON.stringify(parsed, null, 2)}
              </pre>
            </details>
          )}

          {extracted.clarificationsNeeded?.length > 0 && (
            <div className="match-list match-list-warn" style={{ marginBottom: 10 }}>
              <h4>Needed from the customer</h4>
              <ul>
                {extracted.clarificationsNeeded.map((c, i) => (
                  <li key={i}><strong>{c.parameter}</strong>{c.candidateValues ? ` — ${c.candidateValues.join(' / ')}` : ''}</li>
                ))}
              </ul>
            </div>
          )}

          {item.matches?.length ? item.matches.map((m) => <MatchRow key={m.id} m={m} />)
            : <div className="hint">No products matched this line.</div>}
        </div>
      )}
    </div>
  );
}

export default function EnquiryHistoryPage() {
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    api.getEnquiries().then(setList).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (selected == null) { setDetail(null); return; }
    setLoadingDetail(true);
    api.getEnquiry(selected)
      .then(setDetail)
      .catch((e) => setError(e.message))
      .finally(() => setLoadingDetail(false));
  }, [selected]);

  return (
    <div className="chat-shell">
      <TopBar title="Enquiry History" />
      <div className="match-page" style={{ padding: 20 }}>
        <button className="link-btn" onClick={() => navigate('/chat')}>← New enquiry</button>

        {error && <div className="error-box" style={{ marginTop: 12 }}>{error}</div>}

        {list === null && !error && <div className="hint" style={{ marginTop: 20 }}>Loading…</div>}

        {list?.length === 0 && (
          <div className="empty-state panel" style={{ marginTop: 16, padding: 30 }}>
            <p>No enquiries recorded yet.</p>
            <p className="hint">
              Every enquiry run from now on is saved automatically — the products matched, the
              deviations flagged, and the specs the customer left unstated.
            </p>
            <button className="primary-btn" onClick={() => navigate('/chat')}>Run one</button>
          </div>
        )}

        {list?.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) 1fr', gap: 16, marginTop: 16, alignItems: 'start' }}>
            <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr><th style={{ textAlign: 'left', padding: 10 }}>Enquiry</th><th style={{ textAlign: 'right', padding: 10 }}>Items</th></tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                      style={{
                        cursor: 'pointer',
                        borderTop: '1px solid rgba(0,0,0,.08)',
                        background: selected === e.id ? 'rgba(0,0,0,.05)' : 'transparent',
                      }}
                    >
                      <td style={{ padding: 10 }}>
                        <div style={{ fontWeight: 600 }}>{e.customer_name || e.source_filename || `Enquiry #${e.id}`}</div>
                        <div className="hint">{fmtDate(e.uploaded_at)} · <SourceChip type={e.source_type} quality={e.source_quality} /></div>
                      </td>
                      <td style={{ padding: 10, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div>{e.item_count}</div>
                        <div className="hint">{e.match_count} matches</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              {selected == null && <div className="panel empty-state" style={{ padding: 30 }}>Select an enquiry to see its line items, matches and deviations.</div>}
              {loadingDetail && <div className="hint">Loading…</div>}
              {detail && !loadingDetail && (
                <>
                  <div className="panel" style={{ padding: 14, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{detail.customer_name || detail.source_filename || `Enquiry #${detail.id}`}</div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      {fmtDate(detail.uploaded_at)} · <SourceChip type={detail.source_type} quality={detail.source_quality} />
                      {detail.split_method && <> · split: {detail.split_method}</>}
                      {detail.stage && <> · stage: {detail.stage}</>}
                    </div>
                    {detail.source_quality === 'ocr_pdf' && (
                      <div className="match-list match-list-warn" style={{ marginTop: 10 }}>
                        <h4>Scanned document</h4>
                        <ul><li>Almost no text could be extracted, so matching had very little to work with. OCR is not yet available.</li></ul>
                      </div>
                    )}
                  </div>
                  {detail.items?.map((it) => <LineItem key={it.id} item={it} />)}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
