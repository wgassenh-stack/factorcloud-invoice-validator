'use client';

import { useEffect, useState } from 'react';
import { portalConfig } from '@/lib/portal-config';
import { DEMO_DRIVER, demoInBrowser, demoViewInBrowser } from '@/lib/demo';
import { SessionUser } from './SessionUser';
import { DemoToggle } from './DemoToggle';
import { ViewSwitch } from './ViewSwitch';
import { ConnectionLink } from './ConnectionLink';

type NavKey = 'home' | 'invoices' | 'submit' | 'batch' | 'statements' | 'driver';

export function PortalNav({ active }: { active: NavKey }) {
  // Demo only: the Driver view trims the menu to sending paperwork and the driver's own invoices.
  const [driver, setDriver] = useState(false);
  useEffect(() => { setDriver(active === 'driver' || (demoInBrowser() && demoViewInBrowser() === 'driver')); }, [active]);

  const managerLinks = [
    { key: 'home', href: '/', label: 'Dashboard', enabled: true, icon: 'home' },
    { key: 'invoices', href: '/invoices', label: 'Invoices', enabled: portalConfig.features.invoices, icon: 'invoice' },
    { key: 'submit', href: '/submit', label: 'Submit invoice', enabled: portalConfig.features.submit, icon: 'upload' },
    { key: 'batch', href: '/batch', label: 'Batch upload', enabled: portalConfig.features.batch, icon: 'batch' },
    { key: 'statements', href: '/statements', label: 'Statements', enabled: portalConfig.features.statements, icon: 'statement' },
  ] as const;
  const driverLinks = [
    { key: 'driver', href: '/driver', label: 'My invoices', enabled: true, icon: 'invoice' },
    { key: 'submit', href: '/submit', label: 'Send in paperwork', enabled: portalConfig.features.submit, icon: 'upload' },
  ] as const;
  const links = driver ? driverLinks : managerLinks;

  return <nav className="portalNav">
    <a className="portalBrand" href={driver ? '/driver' : '/'} aria-label="FactorCloud client portal home">
      <img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" />
    </a>

    <ViewSwitch current="client" />

    <div className="portalNavLinks">
      {links.filter((link) => link.enabled).map((link) => <a key={link.key} className={active === link.key ? 'active' : ''} href={link.href}>
        <NavIcon name={link.icon} />
        <span>{link.label}</span>
      </a>)}
    </div>

    <div className="portalNavFooter">
      {driver
        ? <div className="portalClientBadge"><span className="portalClientInitial">{DEMO_DRIVER.charAt(0)}</span><div><strong>{DEMO_DRIVER}</strong><small>Driver · {portalConfig.clientShortName}</small></div></div>
        : <div className="portalClientBadge"><span className="portalClientInitial">{portalConfig.clientShortName.charAt(0).toUpperCase()}</span><div><strong>{portalConfig.clientShortName}</strong><small>{portalConfig.environmentLabel}</small></div></div>}
      <DemoToggle />
      {!driver && <ConnectionLink />}
      <SessionUser />
      <div className="portalPowered">Powered by FactorCloud</div>
    </div>
  </nav>;
}

function NavIcon({ name }: { name: string }) {
  if (name === 'home') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20H5V10.5Z"/><path d="M9 20v-6h6v6"/></svg>;
  if (name === 'invoice') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10l3 3v15H7V3Z"/><path d="M17 3v4h3M10 11h7M10 15h7"/></svg>;
  if (name === 'upload') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 14v6h14v-6"/></svg>;
  if (name === 'statement') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>;
  if (name === 'batch') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg>;
}
