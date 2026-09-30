'use client';
import {OpsSignOut} from './OpsSignOut';
import {OpsIcon} from './OpsUI';
import {ViewSwitch} from './ViewSwitch';
import styles from './OpsSidebar.module.css';
const GROUPS=[
  {label:'Operate',links:[{key:'overview',href:'/ops',label:'Overview'},{key:'funding',href:'/ops/funding',label:'Funding Center'},{key:'reviews',href:'/ops/reviews',label:'Paperwork Review'},{key:'recovery',href:'/ops/recovery',label:'Recovery'}]},
  {label:'Portfolio',links:[{key:'debtors',href:'/ops/debtors',label:'Debtors'},{key:'reports',href:'/ops/reports',label:'Reports'}]},
  {label:'Manage',links:[{key:'rules',href:'/ops/rules',label:'Automation Rules'},{key:'team',href:'/ops/team',label:'People & Access'},{key:'connection',href:'/connection',label:'Diagnostics'}]}
] as const;
type LinkKey=(typeof GROUPS)[number]['links'][number]['key'];
export function OpsSidebar({active}:{active:LinkKey}) {return <aside className={'opsSidebar '+styles.sidebar}><div className={styles.brandWrap}><a href="/ops" aria-label="FactorCloud Overview"><img src="/factorcloud-logo.svg" alt="FactorCloud"/></a><span>Factor workspace</span><ViewSwitch current="staff"/></div><nav className={styles.nav} aria-label="Main navigation">{GROUPS.map(group=><div className={styles.group} key={group.label}><span className={styles.groupLabel}>{group.label}</span>{group.links.map(link=><a className={styles.link+' '+(active===link.key?styles.active:'')} key={link.key} href={link.href} aria-current={active===link.key?'page':undefined}><OpsIcon name={link.key}/><span>{link.label}</span></a>)}</div>)}</nav><div className={styles.footer}><div className={styles.identity}><span className={styles.avatar}>FA</span><div><strong>Factor workspace</strong><small>Internal operations</small></div></div><a className={styles.portal} href="/">Client portal ↗</a><OpsSignOut/></div></aside>;}
