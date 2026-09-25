'use client';

import { useState } from 'react';

export function OpsSignOut() {
  const [signingOut, setSigningOut] = useState(false);

  async function logout() {
    setSigningOut(true);
    try {
      await fetch('/api/portal-auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  }

  return <button type="button" className="opsSignOut" onClick={() => void logout()} disabled={signingOut}>
    {signingOut ? 'Signing out...' : 'Sign out'}
  </button>;
}
