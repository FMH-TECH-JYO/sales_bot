// web/src/pages/ChatPage.jsx
import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { api } from '../api';
import TopBar from '../components/TopBar';

const ACCEPTED = '.pdf,.docx,.doc,.xlsx,.xls,.csv,.txt';

export default function ChatPage() {
  const { chatHistory, saveToHistory, openHistoryEntry, enquiry, setEnquiry, startNewChat } = useApp();
  // If we arrived here via "Edit" (enquiry is already set and not cleared), prefill from it.
  const [text, setText] = useState(enquiry?.text || '');
  const [files, setFiles] = useState([]);
  const [existingAttachments] = useState(enquiry?.attachments || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const navigate = useNavigate();
  const isEditing = !!enquiry;

  function addFiles(fileList) {
    setFiles((f) => [...f, ...Array.from(fileList)]);
  }
  function removeFile(idx) {
    setFiles((f) => f.filter((_, i) => i !== idx));
  }

  function handleNewChat() {
    startNewChat();
    setText('');
    setFiles([]);
  }

  function handleOpenHistory(id) {
    const entry = openHistoryEntry(id);
    if (!entry) return;
    setEnquiry(entry.snapshot);
    // Always land back in the chat/transcript view first — the person
    // should see what they asked (and, if matching already ran, a summary
    // of the outcome) before jumping to the full matching screen. They can
    // continue on to /matching with the button below.
    navigate('/chat');
  }

  function handleViewMatch() {
    navigate('/matching');
  }

  async function handleSend() {
    if (!text.trim()) {
      setError('Type your requirement first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Single call: the server detects the product category, fetches only
      // that family's published catalogue products, and asks the LLM to
      // score them against the raw enquiry text. No matching logic runs
      // in the browser anymore.
      const { parsed, results, provider, warning } = await api.matchEnquiry(
        text,
        files.map((f) => f.name)
      );
      if (warning) setError(warning);
      if (!results.length) {
        setError((prev) => prev || 'No matching products were found for this enquiry. Check the admin console has published catalogue entries for this product family.');
      }

      // Append this turn (user message + assistant summary) onto the
      // existing thread instead of overwriting it, so reopening this
      // conversation later shows the whole back-and-forth — not just the
      // most recent message — the same way a real chat history works.
      const newAttachments = files.map((f) => ({ name: f.name, size: f.size, type: f.type }));
      const turn = [
        { role: 'user', text, attachments: newAttachments, at: new Date().toISOString() },
        {
          role: 'assistant',
          at: new Date().toISOString(),
          resultCount: results.length,
          topModel: results[0]?.product?.model,
          topPercent: results[0]?.percent,
          warning: warning || (!results.length ? 'No matching products found.' : null),
        },
      ];
      const messages = [...(enquiry?.messages || []), ...turn];

      const snapshot = {
        text,
        attachments: [...existingAttachments, ...newAttachments],
        parsed,
        results,
        provider,
        selectedIndex: 0,
        messages,
        historyId: enquiry?.historyId || Date.now(), // stable id: editing updates the same conversation, not a new one
      };

      saveToHistory(snapshot);
      setEnquiry(snapshot);
      if (results.length) navigate('/matching');
    } catch (e) {
      setError(`Could not run matching: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-shell">
      <TopBar title={isEditing ? 'Enquiry' : 'New Enquiry'} />
      <div className="chat-body">
        <aside className="chat-sidebar">
          <button className="primary-btn chat-new-btn" onClick={handleNewChat}>
            + New Chat
          </button>
          <div className="chat-history-label">Recent</div>
          <div className="chat-history-list">
            {chatHistory.length === 0 && <div className="hint" style={{ padding: '0 4px' }}>No enquiries yet this session.</div>}
            {chatHistory.map((h) => (
              <div
                key={h.id}
                className={`chat-history-item ${enquiry?.historyId === h.id ? 'chat-history-item-active' : ''}`}
                title={h.title}
                onClick={() => handleOpenHistory(h.id)}
              >
                {h.title}
              </div>
            ))}
          </div>
        </aside>

        <main className="chat-main">
          <div className="chat-canvas">
            {isEditing && enquiry.messages?.length > 0 ? (
              <div className="chat-transcript">
                {enquiry.messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div className="chat-bubble chat-bubble-user" key={i}>
                      {m.text}
                      {m.attachments?.length > 0 && (
                        <div className="chat-bubble-attachments">
                          {m.attachments.map((a, j) => <span key={j} className="chat-bubble-attachment">📎 {a.name}</span>)}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="chat-bubble chat-bubble-assistant" key={i}>
                      {m.warning ? (
                        m.warning
                      ) : (
                        <>
                          Found {m.resultCount} candidate{m.resultCount === 1 ? '' : 's'} — top match{' '}
                          <strong>{m.topModel}</strong> at <strong>{m.topPercent}%</strong>.
                        </>
                      )}
                      {i === enquiry.messages.length - 1 && enquiry.results?.length > 0 && (
                        <div style={{ marginTop: 10 }}>
                          <button className="secondary-btn" onClick={handleViewMatch}>View match results →</button>
                        </div>
                      )}
                    </div>
                  )
                )}
              </div>
            ) : (
              <div className="chat-welcome">
                <h2>What are you looking to source?</h2>
                <p>Describe the application in plain language — range, area classification, output signal, anything you know. Attach a spec sheet or enquiry document if you have one.</p>
                <p className="hint">Example: "Need a pressure transmitter for a refinery reactor, 0 to 10 bar gauge, HART output, installed near the ATEX zone."</p>
              </div>
            )}
          </div>

          {(existingAttachments.length > 0 || files.length > 0) && (
            <div className="chat-attachments">
              {existingAttachments.map((f, i) => (
                <div key={'existing-' + i} className="chat-attachment-chip chat-attachment-chip-existing">
                  <span className="attach-icon">📎</span>
                  <span className="attach-name">{f.name}</span>
                  <span className="attach-size">already attached</span>
                </div>
              ))}
              {files.map((f, i) => (
                <div key={i} className="chat-attachment-chip">
                  <span className="attach-icon">📎</span>
                  <span className="attach-name">{f.name}</span>
                  <span className="attach-size">{(f.size / 1024).toFixed(0)} KB</span>
                  <button className="attach-remove" onClick={() => removeFile(i)}>✕</button>
                </div>
              ))}
            </div>
          )}

          {error && <div className="error-box" style={{ margin: '0 20px' }}>{error}</div>}

          <div className="chat-input-bar">
            <button
              className="chat-attach-btn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach a file (PDF, DOCX, XLSX, CSV, TXT)"
            >
              +
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED}
              style={{ display: 'none' }}
              onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
            />
            <textarea
              className="chat-textarea"
              placeholder={isEditing ? 'Continue this conversation…' : 'Describe what you need…'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              rows={1}
            />
            <button className="chat-send-btn" onClick={handleSend} disabled={busy}>
              {busy ? '…' : isEditing ? '↻' : '➤'}
            </button>
          </div>
          <p className="hint" style={{ padding: '0 20px 12px', margin: 0 }}>
            Attachments are captured and shown on the next screen. Matching is now done by the LLM against your published catalogue — automatic text extraction from PDF/DOCX/XLSX attachments is a future improvement; for now, typed text drives matching.
          </p>
        </main>
      </div>
    </div>
  );
}
