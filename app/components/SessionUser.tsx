'use client';

import { useEffect, useState } from 'react';

type SessionResponse = {
  mode: 'pilot' | 'database';
  authenticated: boolean;
  user?: { email: string; displayName: string | null; role: string };
};

export function SessionUser() {
  const [session, setSession] = useState<SessionResponse | null>(null);

  useEffect(() => {
    void fetch('/api/portal-auth/session', { cache: 'no-store' }).then(async (res) => {
      if (res.ok) setSession(await res.json());
    });
  }, []);

  if (!session || session.mode !== 'database' || !session.authenticated || !session.user) return null;

  async function logout() {
    await fetch('/api/portal-auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  return <div className="portalUserSession">
    <strong>{session.user.displayName || session.user.email}</strong>
    <span>{session.user.role.replaceAll('_', ' ')}</span>
    <button type="button" onClick={() => void logout()}>Sign out</button>
  </div>;
}
