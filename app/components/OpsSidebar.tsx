'use client';

import { OpsSignOut } from './OpsSignOut';
import { ViewSwitch } from './ViewSwitch';

const LINKS = [
  { key: 'overview', href: '/ops', label: 'Overview' },
  { key: 'debtors', href: '/ops/debtors', label: 'Debtors' },
  { key: 'reviews', href: '/ops/reviews', label: 'Review queue' },
  { key: 'recovery', href: '/ops/recovery', label: 'Recovery queue' },
  { key: 'team', href: '/ops/team', label: 'Drivers & invitations' },
  { key: 'funding', href: '/ops/funding', label: 'Funding' },
  { key: 'rules', href: '/ops/rules', label: 'Funding rules' },
  { key: 'connection', href: '/connection', label: 'Connection check' },
] as const;

export function OpsSidebar({ active }: { active: (typeof LINKS)[number]['key'] }) {
  return <aside className="opsSidebar">
    <a className="opsBrand" href="/ops"><img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" /></a>
    <div className="opsRole">Factor Operations</div>
    <ViewSwitch current="staff" />
    <nav className="opsNav">
      {LINKS.map((link) => <a key={link.key} className={active === link.key ? 'active' : ''} href={link.href}>{link.label}</a>)}
    </nav>
    <div className="opsSidebarFooter"><strong>Internal view</strong><span>Factor-wide access</span><OpsSignOut /></div>
  </aside>;
}
