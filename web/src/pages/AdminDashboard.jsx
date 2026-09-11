// web/src/pages/AdminDashboard.jsx
//
// The enquiry log on this page used to be mockEnquiryLog() — six invented
// enquiries with real company names (Reliance Refinery, Tata Steel, NTPC…),
// invented owners and invented stages, rendered in the same table as anything
// real would be. A banner said "mock data", but the counters above it added up
// those fake rows, so the dashboard reported a pipeline that did not exist.
//
// GET /enquiries has been real since migration 004. This page now reads it.
// web/src/lib/mockData.js is deleted rather than left unimported: a file full
// of fabricated customer records in a repo is one careless import away from
// being on screen again.

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import TopBar from '../components/TopBar';
import { api } from '../api';

// Deliberately stops at "Offer Sent" — this app doesn't track anything
// downstream of an offer being generated/downloaded (no won/lost outcome).
const STAGE_LABELS = {
  new: 'New',
  extracted: 'Extracted',
  reviewed: 'Reviewed',
  matched: 'Matched',
  offer_drafted: 'Offer drafted',
  offer_sent: 'Offer sent',
};

const STAGE_COLORS = {
  new: '#8b8b8b', extracted: '#3b6ea5', reviewed: '#6b4fa0', matched: '#3b6ea5',
  offer_drafted: '#b8860b', offer_sent: '#1f7a4d',
};

const IN_PROGRESS = ['extracted', 'reviewed', 'matched', 'offer_drafted'];

export default function AdminDashboard() {
  const [filter, setFilter] = useState('all');
  const [enquiries, setEnquiries] = useState([]);
  const [state, setState] = useState('loading');   // 'loading' | 'ready' | 'error'
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getEnquiries(200)
      .then((rows) => {
        if (cancelled) return;
        setEnquiries(Array.isArray(rows) ? rows : []);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        // Say what failed. A silently empty table is indistinguishable from
        // "no enquiries yet", and those need different responses.
        setError(err.message || 'Could not load enquiries.');
        setState('error');
      });
    return () => { cancelled = true; };
  }, []);

  const filtered = filter === 'all' ? enquiries : enquiries.filter((e) => e.stage === filter);

  const counts = {
    new: enquiries.filter((e) => e.stage === 'new').length,
    inProgress: enquiries.filter((e) => IN_PROGRESS.includes(e.stage)).length,
    offersSent: enquiries.filter((e) => e.stage === 'offer_sent').length,
  };

  return (
    <div className="chat-shell">
      <TopBar title="Admin Dashboard" />
      <div className="admin-page">

        {state === 'error' && (
          <div className="admin-note panel" role="alert">
            Could not load the enquiry log: {error}
          </div>
        )}

        <div className="admin-stat-row">
          {/* While loading, show a dash rather than 0 — a real zero and "not
              loaded yet" are different facts and 0 asserts the wrong one. */}
          <div className="admin-stat panel">
            <div className="admin-stat-num">{state === 'ready' ? counts.new : '—'}</div>
            <div className="admin-stat-label">New</div>
          </div>
          <div className="admin-stat panel">
            <div className="admin-stat-num">{state === 'ready' ? counts.inProgress : '—'}</div>
            <div className="admin-stat-label">In progress</div>
          </div>
          <div className="admin-stat panel">
            <div className="admin-stat-num">{state === 'ready' ? counts.offersSent : '—'}</div>
            <div className="admin-stat-label">Offers sent</div>
          </div>
        </div>

        <div className="panel">
          <div className="admin-filter-row">
            <h2 style={{ margin: 0 }}>Enquiry log</h2>
            <div className="admin-filter-chips">
              {['all', 'new', 'matched', 'offer_sent'].map((f) => (
                <button
                  key={f}
                  className={`chip-btn ${filter === f ? 'chip-btn-active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : STAGE_LABELS[f]}
                </button>
              ))}
            </div>
          </div>

          {state === 'loading' && <p className="hint">Loading enquiries…</p>}

          {state === 'ready' && filtered.length === 0 && (
            <p className="hint">
              {enquiries.length === 0
                ? 'No enquiries have been submitted yet. They appear here as soon as a sales engineer runs one through matching.'
                : 'No enquiries at this stage.'}
            </p>
          )}

          {state === 'ready' && filtered.length > 0 && (
            <div className="table-scroll">
              {/* Horizontal scroll lives on this wrapper, not on the table:
                  a table may be wider than a phone screen; the PAGE may not. */}
              <table>
                <thead>
                  <tr>
                    <th>ID</th><th>Customer</th><th>Source</th><th>Items</th>
                    <th>Matches</th><th>Stage</th><th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => (
                    <tr key={e.id}>
                      <td>{e.id}</td>
                      {/* customer_name is nullable — an enquiry pasted as text
                          need not name anyone. "—" is honest; inventing a
                          company name is what this page used to do. */}
                      <td>{e.customer_name || <em>not stated</em>}</td>
                      <td>{e.source_filename || e.source_type}</td>
                      <td>{e.item_count}</td>
                      <td>{e.match_count}</td>
                      <td>
                        <span style={{
                          background: STAGE_COLORS[e.stage] || '#8b8b8b',
                          color: '#fff', borderRadius: 999, padding: '2px 10px',
                          fontSize: 12, fontWeight: 600,
                        }}>
                          {STAGE_LABELS[e.stage] || e.stage}
                        </span>
                      </td>
                      <td>{e.uploaded_at ? new Date(e.uploaded_at).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Catalogue management</h2>
          <p className="hint">Upload, review AI-drafted product data, and publish new catalogues — live against the real database.</p>
          <Link to="/admin/catalogues" className="primary-btn" style={{ display: 'inline-block', textDecoration: 'none' }}>
            Open Catalogue Manager →
          </Link>
        </div>
      </div>
    </div>
  );
}
