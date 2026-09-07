// web/src/context/AppContext.jsx
//
// One context for the two things that need to survive page navigation:
// (1) who's logged in (admin/user — client-side only, no real auth backend
// yet, role persisted to localStorage so a refresh doesn't log you out), and
// (2) the enquiry currently being worked on (text, attachments, match
// results, selected product, offer draft) as it flows through
// Chat -> Matching -> Offer.
//
// Chat history stores a FULL SNAPSHOT of each enquiry (not just its title),
// so reopening a past conversation actually restores it, per the
// "recent chats must work like the real chatbot" requirement — clicking one
// re-populates `enquiry` exactly as it was and drops the user back on the
// matching page they'd reached, not a blank screen.

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const AppCtx = createContext(null);

const ROLE_KEY = 'fm_role';
const HISTORY_KEY = 'fm_chat_history';

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return []; // corrupted/old-shape data shouldn't crash the app on load
  }
}

export function AppProvider({ children }) {
  const [role, setRole] = useState(() => localStorage.getItem(ROLE_KEY) || null);
  // Persisted to localStorage so chat history survives a page refresh or
  // reopening the app later, not just navigation within one session.
  const [chatHistory, setChatHistory] = useState(loadHistory); // [{id, title, createdAt, snapshot: {text, attachments, parsed, results, selectedIndex, messages}}]
  const [enquiry, setEnquiry] = useState(null);        // current live snapshot, same shape as history[].snapshot
  const [offer, setOffer] = useState(null);            // { version, quantity, specialRequirement, notes: [{version, field, from, to}] }

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
    } catch (e) {
      console.error('Could not persist chat history:', e); // e.g. quota exceeded — history still works for this session
    }
  }, [chatHistory]);

  const login = useCallback((r) => {
    localStorage.setItem(ROLE_KEY, r);
    setRole(r);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(ROLE_KEY);
    setRole(null);
    setEnquiry(null);
    setOffer(null);
  }, []);

  /** Reset fully — clears the working enquiry AND any offer draft, exactly like restarting the bot. Chat history (the list itself) is left intact, matching normal chatbot UX (old conversations stay in the sidebar). */
  const startNewChat = useCallback(() => {
    setEnquiry(null);
    setOffer(null);
  }, []);

  /** Save (or update) the current enquiry into history as a full, reopenable snapshot.
   * The title is fixed from the FIRST message in the thread and never changes on later
   * turns — otherwise a conversation's name would keep jumping around as it's edited,
   * which defeats the point of a stable history list. */
  const saveToHistory = useCallback((snapshot) => {
    setChatHistory((h) => {
      const existingIdx = snapshot.historyId ? h.findIndex((x) => x.id === snapshot.historyId) : -1;
      const firstText = existingIdx >= 0 ? h[existingIdx].snapshot.messages?.[0]?.text || snapshot.text : snapshot.text;
      const title = firstText.slice(0, 48) + (firstText.length > 48 ? '…' : '');
      const entry = { id: snapshot.historyId || Date.now(), title, createdAt: new Date().toISOString(), snapshot };
      if (existingIdx >= 0) {
        const copy = [...h];
        copy[existingIdx] = entry;
        return copy;
      }
      return [entry, ...h].slice(0, 30);
    });
  }, []);

  /** Reopen a past conversation exactly as it was left. */
  const openHistoryEntry = useCallback((entryId) => {
    let found = null;
    setChatHistory((h) => {
      found = h.find((x) => x.id === entryId) || null;
      return h;
    });
    return found;
  }, []);

  const value = {
    role, login, logout,
    chatHistory, saveToHistory, openHistoryEntry,
    enquiry, setEnquiry, startNewChat,
    offer, setOffer,
  };

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
