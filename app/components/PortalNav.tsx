'use client';

import { portalConfig } from '@/lib/portal-config';

export function PortalNav({ active }: { active: 'home' | 'invoices' | 'submit' | 'batch' | 'risk' }) {
  const links = [
    { key: 'home', href: '/', label: 'Dashboard', enabled: true },
    { key: 'invoices', href: '/invoices', label: 'Invoices', enabled: portalConfig.features.invoices },
    { key: 'submit', href: '/submit', label: 'Submit invoice', enabled: portalConfig.features.submit },
    { key: 'batch', href: '/batch', label: 'Batch upload', enabled: portalConfig.features.batch },
    { key: 'risk', href: '/risk', label: 'Alerts', enabled: portalConfig.features.alerts },
  ] as const;

  return <nav className="portalNav">
    <a className="portalBrand" href="/" aria-label="FactorCloud client portal home">
      <img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" />
      <span className="portalBrandDivider" />
      <strong>Client Portal</strong>
    </a>
    <div className="portalNavLinks">
      {links.filter((link) => link.enabled).map((link) => <a key={link.key} className={active === link.key ? 'active' : ''} href={link.href}>{link.label}</a>)}
    </div>
    <div className="portalAccount">
      <strong>{portalConfig.clientShortName}</strong>
      <span>{portalConfig.environmentLabel}</span>
    </div>
  </nav>;
}
