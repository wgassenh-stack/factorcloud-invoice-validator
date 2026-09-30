'use client';

import { OpsSignOut } from './OpsSignOut';
import { ViewSwitch } from './ViewSwitch';
import styles from './OpsSidebar.module.css';

const GROUPS = [
  {
    label: 'Automation',
    links: [
      { key: 'overview', href: '/ops', label: 'Automation center', icon: 'A' },
      { key: 'funding', href: '/ops/funding', label: 'Funding', icon: '$' },
      { key: 'reviews', href: '/ops/reviews', label: 'Review queue', icon: 'R' },
      { key: 'recovery', href: '/ops/recovery', label: 'Recovery', icon: '!' },
    ],
  },
  {
    label: 'Portfolio',
    links: [
      { key: 'clients', href: '/ops#portfolio', label: 'Clients', icon: 'C' },
      { key: 'debtors', href: '/ops/debtors', label: 'Debtors', icon: 'D' },
    ],
  },
  {
    label: 'Configure',
    links: [
      { key: 'rules', href: '/ops/rules', label: 'Rules & automation', icon: '⚙' },
      { key: 'team', href: '/ops/team', label: 'Drivers & access', icon: 'U' },
    ],
  },
  {
    label: 'Admin',
    links: [
      { key: 'connection', href: '/connection', label: 'Diagnostics', icon: '↗' },
    ],
  },
] as const;

type LinkKey = (typeof GROUPS)[number]['links'][number]['key'];

export function OpsSidebar({ active }: { active: LinkKey }) {
  return <aside className={`opsSidebar ${styles.sidebar}`}>
    <div className={styles.brandWrap}>
      <a className="opsBrand" href="/ops"><img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" /></a>
      <div className={styles.context}>
        <span>Factor workspace</span>
        <strong>Automation & Operations</strong>
      </div>
    </div>

    <ViewSwitch current="staff" />

    <nav className={styles.nav}>
      {GROUPS.map((group) => <div className={styles.group} key={group.label}>
        <span className={styles.groupLabel}>{group.label}</span>
        {group.links.map((link) => <a
          key={link.key}
          className={`${styles.link} ${active === link.key ? styles.active : ''}`}
          href={link.href}
        >
          <span className={styles.icon} aria-hidden="true">{link.icon}</span>
          <span>{link.label}</span>
        </a>)}
      </div>)}
    </nav>

    <div className={`${styles.footer} opsSidebarFooter`}>
      <div className={styles.footerMeta}><strong>Internal factor view</strong><span>Factor-wide access</span></div>
      <OpsSignOut />
    </div>
  </aside>;
}
