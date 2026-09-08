import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import TopBar from '../components/TopBar';

const STATUS_COLORS = {
  uploaded: '#8b8b8b',
  parsing: '#8b8b8b',
  parsed: '#3b6ea5',
  drafted: '#6b4fa0',
  in_review: '#b8860b',
  published: '#1f7a4d',
  rejected: '#b03030',
};

const OUTPUT_OPTIONS = ['switch', '4-20mA', 'hart', 'modbus', 'visual'];
const HAZARDOUS_OPTIONS = ['safe', 'flameproof', 'both'];

function StatusBadge({ status }) {
  return (
    <span
      style={{
        background: STATUS_COLORS[status] || '#8b8b8b',
        color: '#fff',
        borderRadius: 999,
        padding: '2px 10px',
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {status}
    </span>
  );
}

function ConfidenceDot({ value }) {
  if (value == null) return <span className="conf-dot conf-none" title="No confidence data" />;
  const color = value >= 0.8 ? '#1f7a4d' : value >= 0.5 ? '#b8860b' : '#b03030';
  return <span className="conf-dot" style={{ background: color }} title={`Confidence: ${value}`} />;
}

// ---------------------------------------------------------------------------
// Upload panel
// ---------------------------------------------------------------------------
function UploadPanel({ categories, onUploaded, onCategoryCreated }) {
  const [file, setFile] = useState(null);
  const [categoryId, setCategoryId] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newCat, setNewCat] = useState({ id: '', label: '', unit: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleCreateCategory() {
    if (!newCat.id || !newCat.label) {
      setError('New category needs at least an id and a label.');
      return;
    }
    try {
      const created = await api.createCategory(newCat);
      onCategoryCreated(created);
      setCategoryId(created.id);
      setShowNewCategory(false);
      setNewCat({ id: '', label: '', unit: '' });
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleUpload() {
    if (!file) {
      setError('Choose a PDF first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.uploadFile(file, categoryId || null);
      onUploaded(result);
      setFile(null);
      document.getElementById('file-input').value = '';
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Upload a catalogue</h2>
      <div className="upload-row">
        <input id="file-input" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files[0])} />
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">— No category yet (manual entry later) —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <button className="link-btn" onClick={() => setShowNewCategory((s) => !s)}>
          + New category
        </button>
        <button className="primary-btn" onClick={handleUpload} disabled={busy}>
          {busy ? 'Uploading…' : 'Upload & draft'}
        </button>
      </div>

      {showNewCategory && (
        <div className="new-cat-row">
          <input
            placeholder="id (e.g. diaphragm_seal)"
            value={newCat.id}
            onChange={(e) => setNewCat({ ...newCat, id: e.target.value })}
          />
          <input
            placeholder="Label (e.g. Diaphragm Seal)"
            value={newCat.label}
            onChange={(e) => setNewCat({ ...newCat, label: e.target.value })}
          />
          <input
            placeholder="Unit (e.g. bar)"
            value={newCat.unit}
            onChange={(e) => setNewCat({ ...newCat, unit: e.target.value })}
          />
          <button className="primary-btn" onClick={handleCreateCategory}>
            Create category
          </button>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
      <p className="hint">
        If you don't pick a category, the file is still parsed and stored — you'll fill the product form manually
        (or pick a category and click "Run AI draft" later from the review panel).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Uploads table
// ---------------------------------------------------------------------------
function UploadsTable({ uploads, selectedId, onSelect }) {
  return (
    <div className="panel">
      <h2>Catalogue uploads ({uploads.length})</h2>
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Category</th>
            <th>Status</th>
            <th>Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {uploads.map((u) => (
            <tr key={u.id} className={u.id === selectedId ? 'row-selected' : ''} onClick={() => onSelect(u.id)}>
              <td>{u.original_filename}</td>
              <td>{u.category_id || <em>none</em>}</td>
              <td>
                <StatusBadge status={u.status} />
              </td>
              <td>{new Date(u.uploaded_at).toLocaleString()}</td>
            </tr>
          ))}
          {uploads.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No uploads yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review panel — the core of the workflow
// ---------------------------------------------------------------------------
function ReviewPanel({ uploadId, categories, onChanged }) {
  const [upload, setUpload] = useState(null);
  const [form, setForm] = useState(null);
  const [industriesText, setIndustriesText] = useState('');
  const [extraSpecsText, setExtraSpecsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [categoryOverride, setCategoryOverride] = useState('');

  // Extra specs are the family-specific attributes that don't have a fixed
  // column (RTD wiring, switch differential, level measurement principle,
  // indicator power type, etc.) — edited here as one "Label: Value" per
  // line, same shape the AI draft produces, so the reviewer can add/fix
  // whatever's specific to THIS product family before publishing.
  function extraSpecsToText(specs) {
    return (specs || []).map((s) => `${s.label}: ${s.value}`).join('\n');
  }
  function textToExtraSpecs(text) {
    return text.split('\n').map((line) => {
      const idx = line.indexOf(':');
      if (idx < 0) return null;
      const label = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      return label && value ? { label, value } : null;
    }).filter(Boolean);
  }

  const load = useCallback(async () => {
    if (!uploadId) return;
    const data = await api.getUpload(uploadId);
    setUpload(data);
    setForm(
      data.extracted_json || {
        id: '', model: '', family: '', blurb: '', val_min: '', val_max: '', temp_max: '',
        accuracy: '', output_type: 'switch', hazardous: 'safe', connection: '', industries: [], extra_specs: [],
      }
    );
    setIndustriesText((data.extracted_json?.industries || []).join(', '));
    setExtraSpecsText(extraSpecsToText(data.extracted_json?.extra_specs));
    setCategoryOverride(data.category_id || '');
    setError(null);
  }, [uploadId]);

  useEffect(() => { load(); }, [load]);

  if (!uploadId) {
    return (
      <div className="panel review-empty">
        <p>Select an upload on the left to review its draft.</p>
      </div>
    );
  }
  if (!upload || !form) return <div className="panel">Loading…</div>;

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleRunDraft() {
    if (!categoryOverride) {
      setError('Pick a category first — the draft prompt uses it for context.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.retryDraft(uploadId, categoryOverride);
      setUpload(updated);
      setForm(updated.extracted_json);
      setIndustriesText((updated.extracted_json?.industries || []).join(', '));
      setExtraSpecsText(extraSpecsToText(updated.extracted_json?.extra_specs));
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...form,
        val_min: form.val_min === '' ? null : Number(form.val_min),
        val_max: form.val_max === '' ? null : Number(form.val_max),
        temp_max: form.temp_max === '' ? null : Number(form.temp_max),
        industries: industriesText.split(',').map((s) => s.trim()).filter(Boolean),
        extra_specs: textToExtraSpecs(extraSpecsText),
      };
      const updated = await api.updateDraft(uploadId, { category_id: categoryOverride || null, extracted_json: payload });
      setUpload(updated);
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    setBusy(true);
    setError(null);
    try {
      await handleSave();
      const result = await api.publish(uploadId);
      alert(`Published as product "${result.product_id}"`);
      load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReject() {
    if (!confirm('Reject this upload? It will be marked rejected and excluded from the product catalogue.')) return;
    setBusy(true);
    try {
      await api.reject(uploadId);
      load();
      onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const confidence = upload.confidence_json || {};
  const canPublish = form.id && form.family && categoryOverride;

  return (
    <div className="panel review-panel">
      <div className="review-header">
        <h2>{upload.original_filename}</h2>
        <div className="review-actions">
          <a href={api.fileUrl(upload.id)} target="_blank" rel="noreferrer" className="link-btn">
            View original PDF ↗
          </a>
          <StatusBadge status={upload.status} />
        </div>
      </div>

      <div className="field-row">
        <label>Category</label>
        <select value={categoryOverride} onChange={(e) => setCategoryOverride(e.target.value)}>
          <option value="">— choose —</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <button className="secondary-btn" onClick={handleRunDraft} disabled={busy}>
          {upload.extracted_json ? 'Re-run AI draft' : 'Run AI draft'}
        </button>
      </div>

      {upload.extraction_provider && <p className="hint">Drafted by: {upload.extraction_provider}</p>}

      <div className="form-grid">
        <div className="field-row">
          <label><ConfidenceDot value={confidence.id} /> Product code (id)</label>
          <input value={form.id || ''} onChange={(e) => setField('id', e.target.value)} placeholder="e.g. WP, FMPT-7000" />
        </div>
        <div className="field-row">
          <label><ConfidenceDot value={confidence.family} /> Family name</label>
          <input value={form.family || ''} onChange={(e) => setField('family', e.target.value)} />
        </div>
        <div className="field-row full">
          <label><ConfidenceDot value={confidence.blurb} /> Blurb</label>
          <textarea value={form.blurb || ''} onChange={(e) => setField('blurb', e.target.value)} rows={2} />
        </div>
        <div className="field-row">
          <label><ConfidenceDot value={confidence.val_min} /> Range min</label>
          <input type="number" value={form.val_min ?? ''} onChange={(e) => setField('val_min', e.target.value)} />
        </div>
        <div className="field-row">
          <label><ConfidenceDot value={confidence.val_max} /> Range max</label>
          <input type="number" value={form.val_max ?? ''} onChange={(e) => setField('val_max', e.target.value)} />
        </div>
        <div className="field-row">
          <label><ConfidenceDot value={confidence.temp_max} /> Max temp (°C)</label>
          <input type="number" value={form.temp_max ?? ''} onChange={(e) => setField('temp_max', e.target.value)} />
        </div>
        <div className="field-row">
          <label>Accuracy</label>
          <input value={form.accuracy || ''} onChange={(e) => setField('accuracy', e.target.value)} />
        </div>
        <div className="field-row">
          <label><ConfidenceDot value={confidence.output_type} /> Output type</label>
          <select value={form.output_type || 'switch'} onChange={(e) => setField('output_type', e.target.value)}>
            {OUTPUT_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="field-row">
          <label><ConfidenceDot value={confidence.hazardous} /> Area classification</label>
          <select value={form.hazardous || 'safe'} onChange={(e) => setField('hazardous', e.target.value)}>
            {HAZARDOUS_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="field-row">
          <label><ConfidenceDot value={confidence.connection} /> Connection</label>
          <input value={form.connection || ''} onChange={(e) => setField('connection', e.target.value)} />
        </div>
        <div className="field-row full">
          <label><ConfidenceDot value={confidence.industries} /> Industries (comma-separated)</label>
          <input value={industriesText} onChange={(e) => setIndustriesText(e.target.value)} />
        </div>
        <div className="field-row full">
          <label><ConfidenceDot value={confidence.extra_specs} /> Extra specs — one per line, "Label: Value"</label>
          <textarea
            value={extraSpecsText}
            onChange={(e) => setExtraSpecsText(e.target.value)}
            rows={4}
            placeholder={'Wiring: 3-wire\nElement: Pt100 Class B\nDifferential: adjustable, 10-20% of range'}
          />
          <p className="hint" style={{ marginTop: 2 }}>
            Whatever matters for THIS product family and isn't one of the fixed fields above — matching uses these too.
          </p>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="review-footer">
        <button className="secondary-btn" onClick={handleSave} disabled={busy}>Save draft</button>
        <button className="danger-btn" onClick={handleReject} disabled={busy}>Reject</button>
        <button className="primary-btn" onClick={handlePublish} disabled={busy || !canPublish}>
          Publish product
        </button>
        {!canPublish && <span className="hint">Need at least: product code, family, and category to publish.</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function CatalogueManager() {
  const [categories, setCategories] = useState([]);
  const [uploads, setUploads] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const refreshUploads = useCallback(() => {
    api.getUploads().then(setUploads).catch(console.error);
  }, []);

  useEffect(() => {
    api.getCategories().then(setCategories).catch(console.error);
    refreshUploads();
  }, [refreshUploads]);

  return (
    <div className="chat-shell">
      <TopBar title="Catalogue Manager" />
      <div className="app" style={{ paddingTop: 20 }}>
        <Link to="/admin" className="link-btn">← Back to admin dashboard</Link>
        <header className="app-header" style={{ marginTop: 10 }}>
          <h1>Catalogue Manager</h1>
          <p>Upload a datasheet PDF, review the AI-drafted product record, publish when it's ready.</p>
        </header>

      <UploadPanel
        categories={categories}
        onCategoryCreated={(c) => setCategories((cats) => [...cats, c])}
        onUploaded={() => refreshUploads()}
      />

      <div className="split">
        <UploadsTable uploads={uploads} selectedId={selectedId} onSelect={setSelectedId} />
        <ReviewPanel uploadId={selectedId} categories={categories} onChanged={refreshUploads} />
      </div>
      </div>
    </div>
  );
}
