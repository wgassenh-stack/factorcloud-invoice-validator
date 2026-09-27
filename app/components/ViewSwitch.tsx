'use client';

import { useEffect, useState } from 'react';
import { demoInBrowser, demoViewInBrowser, setDemoViewInBrowser, type DemoClientView } from '@/lib/demo';

type SessionInfo = { mode: 'pilot' | 'database' | 'demo'; authenticated: boolean; user?: { role: string } };

/**
 * Switch between the client side (as the company's manager, or in demo as one of its drivers) and
 * the factor's view. Shown only when the viewer can open more than one: in demo mode, or when
 * signed in as factor staff. The Driver view exists only with demo data for now.
 */
export function ViewSwitch({ current }: { current: 'client' | 'staff' }) {
  const [options, setOptions] = useState<{ demo: boolean; show: boolean }>({ demo: false, show: false });
  const [clientView, setClientView] = useState<DemoClientView>('manager');

  useEffect(() => {
    setClientView(demoViewInBrowser());
    void fetch('/api/portal-auth/session', { cache: 'no-store' }).then(async (res) => {
      if (!res.ok) return;
      const session = await res.json() as SessionInfo;
      const demo = session.mode === 'demo' || demoInBrowser();
      const staff = session.mode === 'database' && session.authenticated && session.user?.role !== 'CLIENT_USER';
      setOptions({ demo, show: demo || staff });
    }).catch(() => {});
  }, []);

  if (!options.show) return null;
  const active = current === 'staff' ? 'factor' : options.demo ? clientView : 'manager';
  const tabs = [
    { key: 'manager', label: 'Manager', href: '/', view: 'manager' as const },
    ...(options.demo ? [{ key: 'driver', label: 'Driver', href: '/driver', view: 'driver' as const }] : []),
    { key: 'factor', label: 'Factor', href: '/ops', view: null },
  ];
  return <nav className={`viewSwitch ${tabs.length === 3 ? 'three' : ''}`} aria-label="Portal view">
    {tabs.map((tab) => <a
      key={tab.key}
      href={tab.href}
      className={active === tab.key ? 'active' : ''}
      aria-current={active === tab.key ? 'page' : undefined}
      onClick={() => { if (tab.view) setDemoViewInBrowser(tab.view); }}
    >{tab.label}</a>)}
  </nav>;
}
