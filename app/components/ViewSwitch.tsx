'use client';

import { useEffect, useState } from 'react';
import { demoInBrowser } from '@/lib/demo';

type SessionInfo = { mode: 'pilot' | 'database' | 'demo'; authenticated: boolean; user?: { role: string } };

/**
 * Client | Staff switch between the client portal and the factor (staff) view. Shown only when the
 * viewer can open both: in demo mode, or when signed in as factor staff.
 */
export function ViewSwitch({ current }: { current: 'client' | 'staff' }) {
  const [canSwitch, setCanSwitch] = useState(false);

  useEffect(() => {
    void fetch('/api/portal-auth/session', { cache: 'no-store' }).then(async (res) => {
      if (!res.ok) return;
      const session = await res.json() as SessionInfo;
      const demo = session.mode === 'demo' || demoInBrowser();
      const staff = session.mode === 'database' && session.authenticated && session.user?.role !== 'CLIENT_USER';
      setCanSwitch(demo || staff);
    }).catch(() => {});
  }, []);

  if (!canSwitch) return null;
  return <nav className="viewSwitch" aria-label="Portal view">
    <a href="/" className={current === 'client' ? 'active' : ''} aria-current={current === 'client' ? 'page' : undefined}>Client</a>
    <a href="/ops" className={current === 'staff' ? 'active' : ''} aria-current={current === 'staff' ? 'page' : undefined}>Staff</a>
  </nav>;
}
