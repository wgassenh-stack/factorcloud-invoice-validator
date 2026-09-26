'use client';

import { useEffect, useState } from 'react';

/** Link to the FactorCloud connection check, for whoever runs this deployment (never client users). */
export function ConnectionLink() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    void fetch('/api/portal-auth/session', { cache: 'no-store' }).then(async (res) => {
      if (!res.ok) return;
      const session = await res.json() as { mode: string; authenticated: boolean; user?: { role: string } };
      // Shared-password and demo setups are run by the owner; with real sign-in, staff only.
      setShow(session.mode !== 'database' || (session.authenticated && session.user?.role !== 'CLIENT_USER'));
    }).catch(() => {});
  }, []);
  if (!show) return null;
  return <a className="connectionLink" href="/connection"><span aria-hidden="true">⚡</span>Connection check</a>;
}
