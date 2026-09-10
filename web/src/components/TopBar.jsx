// web/src/components/TopBar.jsx
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import fmLogoWhite from '../assets/fm_logo_white_transparent.png';

const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  sales_engineer: 'Sales Engineer',
};

export default function TopBar({ title }) {
  const { user, role, logout } = useApp();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);

  async function handleLogout() {
    if (signingOut) return;
    setSigningOut(true);
    // logout() revokes the session on the server before clearing local state,
    // so it is asynchronous and this has to wait for it. Navigating first
    // would leave a live session behind if the call failed.
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <header className="top-bar">
      <img src={fmLogoWhite} alt="Forbes Marshall" className="top-bar-logo" />
      <div className="top-bar-title">{title}</div>
      <div className="top-bar-right">
        <button className="link-btn" onClick={() => navigate('/history')}>History</button>
        {/* Name as well as role: on a shared machine, "am I still signed in as
            the person who used this before me" is worth being able to answer
            at a glance. */}
        <span className="role-chip" title={user?.email || ''}>
          {user?.name ? `${user.name} · ` : ''}{ROLE_LABELS[role] || 'Signed in'}
        </span>
        <button className="link-btn top-bar-logout" onClick={handleLogout} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Log out'}
        </button>
      </div>
    </header>
  );
}
