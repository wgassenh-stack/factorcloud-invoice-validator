'use client';

import { portalConfig } from '@/lib/portal-config';

type NavKey = 'home' | 'invoices' | 'submit' | 'batch' | 'risk';

export function PortalNav({ active }: { active: NavKey }) {
  const links = [
    { key: 'home', href: '/', label: 'Dashboard', enabled: true, icon: 'home' },
    { key: 'invoices', href: '/invoices', label: 'Invoices', enabled: portalConfig.features.invoices, icon: 'invoice' },
    { key: 'submit', href: '/submit', label: 'Submit invoice', enabled: portalConfig.features.submit, icon: 'upload' },
    { key: 'batch', href: '/batch', label: 'Batch upload', enabled: portalConfig.features.batch, icon: 'batch' },
    { key: 'risk', href: '/risk', label: 'Alerts', enabled: portalConfig.features.alerts, icon: 'alert' },
  ] as const;

  return <nav className="portalNav">
    <a className="portalBrand" href="/" aria-label="FactorCloud client portal home">
      <img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" />
      <span className="portalBrandSubtitle">Client Portal</span>
    </a>

    <div className="portalNavLinks">
      {links.filter((link) => link.enabled).map((link) => <a key={link.key} className={active === link.key ? 'active' : ''} href={link.href}>
        <NavIcon name={link.icon} />
        <span>{link.label}</span>
      </a>)}
    </div>

    <div className="portalNavFooter">
      <div className="portalClientBadge"><span className="portalClientInitial">{portalConfig.clientShortName.charAt(0).toUpperCase()}</span><div><strong>{portalConfig.clientShortName}</strong><small>{portalConfig.environmentLabel}</small></div></div>
      <div className="portalPowered">Powered by FactorCloud</div>
    </div>
  </nav>;
}

function NavIcon({ name }: { name: string }) {
  if (name === 'home') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20H5V10.5Z"/><path d="M9 20v-6h6v6"/></svg>;
  if (name === 'invoice') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10l3 3v15H7V3Z"/><path d="M17 3v4h3M10 11h7M10 15h7"/></svg>;
  if (name === 'upload') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 14v6h14v-6"/></svg>;
  if (name === 'batch') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg>;
}
