// web/src/pages/LoginPage.jsx
//
// Real sign-in. This screen used to be two buttons — "Admin Login" and "User
// Login" — that wrote a string into localStorage and navigated away. There was
// no password, no server call, and no check on any subsequent request.
//
// Accounts are created with `npm run user:create` (the first admin) or from
// the admin's user list. There is deliberately no "sign up" here: this is an
// internal tool for one sales team, and self-registration on it would be a
// hole, not a feature.

import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import fmLogoBlue from '../assets/fm_logo_blue_transparent.png';

export default function LoginPage() {
  const { login } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const user = await login(email.trim(), password);
      // Send people where they were headed before being bounced here, so a
      // bookmarked /admin/catalogues link survives a session timeout.
      const intended = location.state?.from;
      if (intended) navigate(intended, { replace: true });
      else navigate(user.role === 'admin' ? '/admin' : '/chat', { replace: true });
    } catch (err) {
      // The server returns one message for every failure mode on purpose, so
      // this screen cannot be used to find out who has an account here.
      setError(err.message || 'Could not sign in.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <img src={fmLogoBlue} alt="Forbes Marshall" className="login-logo" />
        <h1>Sales Enquiry Intelligence</h1>
        <p className="login-sub">Sign in to continue</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
              disabled={busy}
            />
          </label>

          <label className="login-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              disabled={busy}
            />
          </label>

          {/* role="alert" so a screen reader announces the failure rather than
              leaving someone wondering why nothing happened. */}
          {error && <p className="login-error" role="alert">{error}</p>}

          <button type="submit" className="login-submit" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login-hint">
          Accounts are created by an administrator. If you cannot sign in, ask them to
          reset your password.
        </p>
      </div>
    </div>
  );
}
