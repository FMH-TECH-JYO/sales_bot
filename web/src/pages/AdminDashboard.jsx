// web/src/pages/AdminDashboard.jsx
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import TopBar from '../components/TopBar';
import { mockEnquiryLog, STAGE_LABELS } from '../lib/mockData';

// Deliberately stops at "Offer Sent" — this app doesn't track anything
// downstream of an offer being generated/downloaded (no won/lost outcome).
const STAGE_COLORS = {
  new: '#8b8b8b', extracted: '#3b6ea5', reviewed: '#6b4fa0', matched: '#3b6ea5',
  offer_drafted: '#b8860b', offer_sent: '#1f7a4d',
};

export default function AdminDashboard() {
  const [filter, setFilter] = useState('all');
  const enquiries = mockEnquiryLog();
  const filtered = filter === 'all' ? enquiries : enquiries.filter((e) => e.stage === filter);

  const counts = {
    new: enquiries.filter((e) => e.stage === 'new').length,
    inProgress: enquiries.filter((e) => ['extracted', 'reviewed', 'matched', 'offer_drafted'].includes(e.stage)).length,
    offersSent: enquiries.filter((e) => e.stage === 'offer_sent').length,
  };

  return (
    <div className="chat-shell">
      <TopBar title="Admin Dashboard" />
      <div className="admin-page">
        <div className="admin-note panel">
          Enquiry log below is mock data — the real enquiry-tracking backend (see <code>enquiries</code> /
          <code>enquiry_stage_history</code> in schema.sql) isn't built yet. Catalogue management further down
          is fully live against the real database.
        </div>

        <div className="admin-stat-row">
          <div className="admin-stat panel"><div className="admin-stat-num">{counts.new}</div><div className="admin-stat-label">New</div></div>
          <div className="admin-stat panel"><div className="admin-stat-num">{counts.inProgress}</div><div className="admin-stat-label">In progress</div></div>
          <div className="admin-stat panel"><div className="admin-stat-num">{counts.offersSent}</div><div className="admin-stat-label">Offers sent</div></div>
        </div>

        <div className="panel">
          <div className="admin-filter-row">
            <h2 style={{ margin: 0 }}>Enquiry log</h2>
            <div className="admin-filter-chips">
              {['all', 'new', 'matched', 'offer_sent'].map((f) => (
                <button key={f} className={`chip-btn ${filter === f ? 'chip-btn-active' : ''}`} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : STAGE_LABELS[f]}
                </button>
              ))}
            </div>
          </div>
          <table>
            <thead>
              <tr><th>ID</th><th>Company</th><th>Requirement</th><th>Stage</th><th>Assigned</th><th>Received</th></tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td>{e.company}</td>
                  <td>{e.product_hint}</td>
                  <td>
                    <span style={{ background: STAGE_COLORS[e.stage], color: '#fff', borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>
                      {STAGE_LABELS[e.stage]}
                    </span>
                  </td>
                  <td>{e.assigned_to || <em>unassigned</em>}</td>
                  <td>{new Date(e.received_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
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