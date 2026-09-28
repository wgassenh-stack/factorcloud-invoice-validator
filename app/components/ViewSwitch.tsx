'use client';

import { useEffect, useState } from 'react';
import { demoInBrowser, demoViewInBrowser, setDemoViewInBrowser, type DemoClientView } from '@/lib/demo';

type SessionInfo = { mode: 'pilot' | 'database' | 'demo'; authenticated: boolean; adminViews?: boolean; user?: { role: string } };

/**
 * Switch between the client side (as the company's manager, or as one of its drivers) and the
 * factor's view. Shown only when the viewer can open more than one: in demo mode, when signed in as
 * factor staff, or with admin views on a shared-password test site. The Driver view needs demo
 * data or admin views.
 */
export function ViewSwitch({ current }: { current: 'client' | 'staff' }) {
  const [options, setOptions] = useState<{ driver: boolean; show: boolean }>({ driver: false, show: false });
  const [clientView, setClientView] = useState<DemoClientView>('manager');

  useEffect(() => {
    setClientView(demoViewInBrowser());
    void fetch('/api/portal-auth/session', { cache: 'no-store' }).then(async (res) => {
      if (!res.ok) return;
      const session = await res.json() as SessionInfo;
      const demo = session.mode === 'demo' || demoInBrowser();
      const staff = session.mode === 'database' && session.authenticated && session.user?.role !== 'CLIENT_USER';
      const admin = session.mode === 'pilot' && Boolean(session.adminViews);
      setOptions({ driver: demo || admin, show: demo || staff || admin });
    }).catch(() => {});
  }, []);

  if (!options.show) return null;
  const active = current === 'staff' ? 'factor' : options.driver ? clientView : 'manager';
  const tabs = [
    { key: 'manager', label: 'Manager', href: '/', view: 'manager' as const },
    ...(options.driver ? [{ key: 'driver', label: 'Driver', href: '/driver', view: 'driver' as const }] : []),
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
