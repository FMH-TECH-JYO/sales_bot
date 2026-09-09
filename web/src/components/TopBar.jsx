// web/src/components/TopBar.jsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import fmLogoWhite from '../assets/fm_logo_white_transparent.png';

export default function TopBar({ title }) {
  const { role, logout } = useApp();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <header className="top-bar">
      <img src={fmLogoWhite} alt="Forbes Marshall" className="top-bar-logo" />
      <div className="top-bar-title">{title}</div>
      <div className="top-bar-right">
        <button className="link-btn" onClick={() => navigate('/history')}>History</button>
        <span className="role-chip">{role === 'admin' ? 'Admin' : 'Sales Engineer'}</span>
        <button className="link-btn top-bar-logout" onClick={handleLogout}>Log out</button>
      </div>
    </header>
  );
}
