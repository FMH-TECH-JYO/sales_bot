// web/src/pages/LoginPage.jsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import fmLogoBlue from '../assets/fm_logo_blue_transparent.png';

export default function LoginPage() {
  const { login } = useApp();
  const navigate = useNavigate();

  function handleLogin(role) {
    login(role);
    navigate(role === 'admin' ? '/admin' : '/chat');
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src={fmLogoBlue} alt="Forbes Marshall" className="login-logo" />
        <h1>Sales Enquiry Intelligence</h1>
        <p className="login-sub">Sign in to continue</p>

        <div className="login-options">
          <button className="login-option login-option-admin" onClick={() => handleLogin('admin')}>
            <span className="login-option-icon">🛠</span>
            <span className="login-option-label">Admin Login</span>
            <span className="login-option-desc">Manage catalogues, view enquiry pipeline</span>
          </button>
          <button className="login-option login-option-user" onClick={() => handleLogin('user')}>
            <span className="login-option-icon">💬</span>
            <span className="login-option-label">User Login</span>
            <span className="login-option-desc">Submit an enquiry, get a matched product</span>
          </button>
        </div>

        <p className="login-hint">No real authentication is wired up yet — this is a role selector for the demo flow.</p>
      </div>
    </div>
  );
}

