'use client';

import { useEffect, useState } from 'react';
import { demoInBrowser, demoMode, demoToggleEnabled } from '@/lib/demo';

/** "Load demo data" switch: swaps this browser between the real portal and the demo portfolio. */
export function DemoToggle({ variant = 'nav' }: { variant?: 'nav' | 'ops' }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setOn(demoInBrowser()), []);
  if (on === null || (!demoToggleEnabled() && !demoMode())) return null;

  async function toggle() {
    setBusy(true);
    try {
      await fetch('/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !on }) });
      // Without real sign-in the factor pages exist only in demo mode, so leaving demo there goes home.
      const stillThere = await fetch(window.location.pathname, { method: 'HEAD', cache: 'no-store' }).then((res) => res.ok).catch(() => true);
      if (!stillThere) { window.location.href = '/'; return; }
    } catch { /* reload below shows whatever state the server has */ }
    window.location.reload();
  }

  const locked = demoMode();
  return <div className={`demoToggle ${variant} ${on ? 'on' : ''}`}>
    <button type="button" role="switch" aria-checked={Boolean(on)} disabled={busy || locked} onClick={() => void toggle()} title={locked ? 'This whole site runs in demo mode.' : undefined}>
      <span className="demoToggleTrack"><i /></span>
      <span className="demoToggleText"><strong>{busy ? 'Switching…' : on ? 'Demo data on' : 'Load demo data'}</strong><small>{on ? 'Fake portfolio · click to exit' : 'Show a sample portfolio'}</small></span>
    </button>
    {on && <a className="demoToggleLink" href={variant === 'ops' ? '/' : '/ops'}>{variant === 'ops' ? 'Open client portal view →' : 'Open factor view →'}</a>}
  </div>;
}
