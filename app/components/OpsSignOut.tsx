'use client';

import { useEffect, useState } from 'react';
import { DemoToggle } from './DemoToggle';

export function OpsSignOut() {
  const [signingOut, setSigningOut] = useState(false);
  // A shared site password can't be signed out of.
  const [sharedPassword, setSharedPassword] = useState(false);
  useEffect(() => {
    void fetch('/api/portal-auth/session', { cache: 'no-store' })
      .then(async (res) => { if (res.ok) setSharedPassword((await res.json()).mode === 'pilot'); })
      .catch(() => {});
  }, []);

  async function logout() {
    setSigningOut(true);
    try {
      await fetch('/api/portal-auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  }

  return <>
    <DemoToggle variant="ops" />
    {!sharedPassword && <button type="button" className="opsSignOut" onClick={() => void logout()} disabled={signingOut}>
      {signingOut ? 'Signing out...' : 'Sign out'}
    </button>}
  </>;
}
