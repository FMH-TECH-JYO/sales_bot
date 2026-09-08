// web/src/pages/AdminDashboard.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import TopBar from '../components/TopBar';
import { api } from '../api';
import { STAGE_LABELS } from '../lib/mockData';

const STAGE_COLORS = {
  new: '#8b8b8b', extracted: '#3b6ea5', reviewed: '#6b4fa0', matched: '#3b6ea5',
  offer_drafted: '#b8860b', offer_sent: '#b8860b', won: '#1f7a4d', lost: '#b03030',
};

const FILTER_STAGES = ['all', 'new', 'matched', 'offer_sent', 'won', 'lost'];

// Real enquiry history — sales-engineer submissions, joined with the
// customer's company name and each enquiry's best match, pulled straight
// from the enquiries/customers/matches tables. This is deliberately a
// separate data source from the catalogue-upload pipeline further down the
// page: an "enquiry" (a customer requirement coming in) and a "catalogue
// upload" (an admin adding a new product datasheet) are unrelated workflows,
// and showing catalogue-upload counts here would be showing the wrong thing.
export default function AdminDashboard() {
  const [filter, setFilter] = useState('all');
  const [enquiries, setEnquiries] = useState([]);
  const [stageCounts, setStageCounts] = useState({ total: 0, byStage: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([api.getEnquiries(filter), api.getEnquiryStageCounts()])
      .then(([list, counts]) => {
        setEnquiries(list);
        setStageCounts(counts);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const inProgress = ['extracted', 'reviewed', 'matched', 'offer_drafted', 'offer_sent']
    .reduce((sum, s) => sum + (stageCounts.byStage[s] || 0), 0);
  const closed = ['won', 'lost'].reduce((sum, s) => sum + (stageCounts.byStage[s] || 0), 0);

  return (
    <div className="chat-shell">
      <TopBar title="Admin Dashboard" />
      <div className="admin-page">
        <div className="admin-stat-row">
          <div className="admin-stat panel"><div className="admin-stat-num">{stageCounts.byStage.new || 0}</div><div className="admin-stat-label">New</div></div>
          <div className="admin-stat panel"><div className="admin-stat-num">{inProgress}</div><div className="admin-stat-label">In progress</div></div>
          <div className="admin-stat panel"><div className="admin-stat-num">{closed}</div><div className="admin-stat-label">Closed</div></div>
        </div>

        <div className="panel">
          <div className="admin-filter-row">
            <h2 style={{ margin: 0 }}>Enquiry history ({stageCounts.total})</h2>
            <div className="admin-filter-chips">
              {FILTER_STAGES.map((f) => (
                <button key={f} className={`chip-btn ${filter === f ? 'chip-btn-active' : ''}`} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : STAGE_LABELS[f]}
                  {f !== 'all' && stageCounts.byStage[f] ? ` (${stageCounts.byStage[f]})` : ''}
                </button>
              ))}
            </div>
          </div>
          {error && <div className="error-box">{error}</div>}
          <table>
            <thead>
              <tr><th>ID</th><th>Company</th><th>Requirement</th><th>Top match</th><th>Stage</th><th>Received</th></tr>
            </thead>
            <tbody>
              {enquiries.map((e) => (
                <tr key={e.id}>
                  <td>ENQ-{e.id}</td>
                  <td>{e.company_name || <em>Unspecified company</em>}</td>
                  <td title={e.raw_text}>{(e.raw_text || '').slice(0, 70)}{(e.raw_text || '').length > 70 ? '…' : ''}</td>
                  <td>{e.top_model ? `${e.top_model} (${e.top_percent}%)` : <em>no match</em>}</td>
                  <td>
                    <span style={{ background: STAGE_COLORS[e.stage] || '#8b8b8b', color: '#fff', borderRadius: 999, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>
                      {STAGE_LABELS[e.stage] || e.stage}
                    </span>
                  </td>
                  <td>{new Date(e.uploaded_at).toLocaleString()}</td>
                </tr>
              ))}
              {!loading && enquiries.length === 0 && (
                <tr><td colSpan={6} className="empty">No enquiries yet — they appear here as soon as a sales engineer runs a match in the chat.</td></tr>
              )}
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