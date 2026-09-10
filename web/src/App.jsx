// web/src/App.jsx
//
// Router root. Every page below reads/writes the shared AppContext for
// the signed-in user + enquiry state, so navigating between them doesn't lose
// data.
//
// What these guards are and are not: they decide what to RENDER, not what is
// permitted. The server checks the session and the role again on every request
// (server/src/middleware/auth.js), and it is that check which protects the
// data. Someone who edits their way past the code here reaches a page whose
// API calls all return 401 or 403 — which is the correct arrangement, because
// anything a browser enforces about itself is advisory.

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';

import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import MatchingPage from './pages/MatchingPage';
import OfferPage from './pages/OfferPage';
import AdminDashboard from './pages/AdminDashboard';
import CatalogueManager from './pages/CatalogueManager';
import EnquiryHistoryPage from './pages/EnquiryHistoryPage';

/**
 * @param {string[]} [roles] roles allowed here. Omit for "any signed-in user".
 */
function RequireRole({ roles, children }) {
  const { authState, role } = useApp();
  const location = useLocation();

  // /auth/me has not answered yet. Rendering the login screen here would flash
  // it in front of an already-signed-in user on every refresh; rendering the
  // page would flash content they may not be allowed to see.
  if (authState === 'loading') {
    return <div className="app-loading" role="status" aria-live="polite">Loading…</div>;
  }

  if (authState !== 'authenticated') {
    // Remember where they were going so LoginPage can send them back there
    // after signing in — a bookmarked /admin/catalogues should survive a
    // session timeout.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (roles && !roles.includes(role)) {
    return <Navigate to={role === 'admin' ? '/admin' : '/chat'} replace />;
  }

  return children;
}

/** Signed-in users have no reason to see the login screen. */
function RedirectIfSignedIn({ children }) {
  const { authState, role } = useApp();
  if (authState === 'loading') return <div className="app-loading" role="status">Loading…</div>;
  if (authState === 'authenticated') {
    return <Navigate to={role === 'admin' ? '/admin' : '/chat'} replace />;
  }
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<RedirectIfSignedIn><LoginPage /></RedirectIfSignedIn>} />

      {/* The enquiry-to-offer flow is every signed-in user's job, admins
          included — an admin is a sales engineer with extra permissions, not a
          different kind of employee. The old code gave these routes
          role="user" exclusively, which locked admins out of the actual
          product. */}
      <Route path="/chat" element={<RequireRole><ChatPage /></RequireRole>} />
      <Route path="/matching" element={<RequireRole><MatchingPage /></RequireRole>} />
      <Route path="/offer" element={<RequireRole><OfferPage /></RequireRole>} />
      {/* History is useful to everyone: engineers review what they quoted,
          admins use it as the demand signal for what to add to the catalogue. */}
      <Route path="/history" element={<RequireRole><EnquiryHistoryPage /></RequireRole>} />

      <Route path="/admin" element={<RequireRole roles={['admin']}><AdminDashboard /></RequireRole>} />
      <Route path="/admin/catalogues" element={<RequireRole roles={['admin']}><CatalogueManager /></RequireRole>} />

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <AppRoutes />
      </AppProvider>
    </BrowserRouter>
  );
}
