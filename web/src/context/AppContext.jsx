// web/src/context/AppContext.jsx
//
// One context for the two things that need to survive page navigation:
// (1) who's signed in, and (2) the enquiry currently being worked on (text,
// attachments, match results, selected product, offer draft) as it flows
// through Chat -> Matching -> Offer.
//
// Authentication used to live here as `localStorage.fm_role`, written by a
// button on the login screen. That was not authentication: the server never
// looked at it, so editing one string in devtools granted admin, and every API
// route was open to anyone who could reach the port regardless.
//
// Now the session is an HttpOnly cookie the server sets, and this context
// holds only a CACHE of who the server says you are. The cache is never
// trusted for access decisions — every guarded call is checked again on the
// server — it exists so the UI can render the right navigation without
// flickering. On mount we ask /auth/me; `authState` distinguishes 'loading'
// (we have not asked yet — render nothing rather than bouncing a signed-in
// user to the login screen) from 'anonymous' and 'authenticated'.
//
// Chat history stores a FULL SNAPSHOT of each enquiry (not just its title),
// so reopening a past conversation actually restores it, per the
// "recent chats must work like the real chatbot" requirement — clicking one
// re-populates `enquiry` exactly as it was and drops the user back on the
// matching page they'd reached, not a blank screen.

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, setUnauthorizedHandler } from '../api';

const AppCtx = createContext(null);

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
  const [user, setUser] = useState(null);              // { id, name, email, role } from the server
  const [authState, setAuthState] = useState('loading'); // 'loading' | 'anonymous' | 'authenticated'
  const role = user?.role || null;
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

  /** Clear the local cache of who is signed in. Does NOT call the server —
   * used both by logout() below and by the 401 handler, where the session is
   * already gone server-side and calling /auth/logout would just 401 again. */
  const clearSession = useCallback(() => {
    setUser(null);
    setAuthState('anonymous');
    setEnquiry(null);   // an enquiry in progress belongs to the person who started it
    setOffer(null);

    // Chat history goes too. It lives in localStorage so it survives a refresh,
    // which also means it survives a DIFFERENT PERSON signing in on the same
    // machine — and these are shared machines in a sales office. Every entry is
    // a full snapshot of a customer's enquiry, so leaving it behind hands the
    // next user the previous user's customers. The server-side history at
    // /history is the durable record; this cache is per-session by design.
    setChatHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch (err) {
      console.error('Could not clear local chat history:', err);
    }
  }, []);

  // A 401 from ANY call means the session ended — it expired, an admin revoked
  // it, or the server restarted against a different database. Handling it in
  // one place means no page has to think about it.
  useEffect(() => {
    setUnauthorizedHandler(() => clearSession());
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  // Ask the server who we are, once, on mount. The cookie is HttpOnly so this
  // is the only way to find out whether it is still valid.
  useEffect(() => {
    let cancelled = false;
    api.me()
      .then(({ user: u }) => { if (!cancelled) { setUser(u); setAuthState('authenticated'); } })
      .catch(() => { if (!cancelled) { setUser(null); setAuthState('anonymous'); } });
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email, password) => {
    const { user: u } = await api.login(email, password);
    setUser(u);
    setAuthState('authenticated');
    return u;
  }, []);

  const logout = useCallback(async () => {
    // Revoke server-side FIRST. Clearing local state without revoking would
    // leave a live session usable by anyone who still has the cookie.
    try {
      await api.logout();
    } catch (err) {
      // The session may already be dead; the local clear below still has to happen.
      console.error('Logout call failed (clearing local session anyway):', err.message);
    }
    clearSession();
  }, [clearSession]);

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
    user, role, authState, login, logout,
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
