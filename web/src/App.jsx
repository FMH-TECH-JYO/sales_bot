// web/src/App.jsx
//
// Router root. Every page below reads/writes the shared AppContext for
// role + enquiry state, so navigating between them doesn't lose data.

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';

import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';
import MatchingPage from './pages/MatchingPage';
import OfferPage from './pages/OfferPage';
import AdminDashboard from './pages/AdminDashboard';
import CatalogueManager from './pages/CatalogueManager';

function RequireRole({ role: required, children }) {
  const { role } = useApp();
  if (!role) return <Navigate to="/login" replace />;
  if (required && role !== required) return <Navigate to={role === 'admin' ? '/admin' : '/chat'} replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route path="/chat" element={<RequireRole role="user"><ChatPage /></RequireRole>} />
      <Route path="/matching" element={<RequireRole role="user"><MatchingPage /></RequireRole>} />
      <Route path="/offer" element={<RequireRole role="user"><OfferPage /></RequireRole>} />

      <Route path="/admin" element={<RequireRole role="admin"><AdminDashboard /></RequireRole>} />
      <Route path="/admin/catalogues" element={<RequireRole role="admin"><CatalogueManager /></RequireRole>} />

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
