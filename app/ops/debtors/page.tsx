'use client';

import { useEffect, useMemo, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { DemoBadge } from '@/app/components/DemoBadge';
import { DashboardSkeleton, StatusFlag, compactMoney, money } from '@/app/components/CommandCharts';
import type { AgingSummary, ExposureItem } from '@/lib/analytics';
import type { DebtorSummary } from '@/lib/debtors';
import styles from './Debtors.module.css';

type Response = {
  today: string;
  debtors: DebtorSummary[];
  aging: AgingSummary;
  exposure: ExposureItem[];
  complete: boolean;
  incompleteReason: string | null;
  demo?: boolean;
  error?: string;
};

type SortKey = 'risk' | 'openBalance' | 'over90' | 'daysToPay' | 'oldestOpenDays' | 'name';
const SLOW_DAYS = 55;

export default function DebtorsPage() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'risk', desc: true });

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/ops/debtors', { cache: 'no-store' });
      const body = await res.json() as Response;
      if (!res.ok) throw new Error(body.error || 'Could not load debtors.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const value = (d: DebtorSummary): number | string => {
      if (sort.key === 'risk') return attentionScore(d);
      if (sort.key === 'over90') return d.buckets[3];
      if (sort.key === 'name') return d.name.toLowerCase();
      return d[sort.key] ?? -1;
    };
    return (data?.debtors ?? [])
      .filter((d) => !needle || d.name.toLowerCase().includes(needle) || (d.topClient ?? '').toLowerCase().includes(needle))
      .sort((a, b) => {
        const x = value(a);
        const y = value(b);
        const cmp = typeof x === 'string' ? String(x).localeCompare(String(y)) : (x as number) - (y as number);
        return sort.desc ? -cmp : cmp;
      });
  }, [data, query, sort]);

  const totals = useMemo(() => {
    const list = data?.debtors ?? [];
    const open = list.reduce((sum, debtor) => sum + debtor.openBalance, 0);
    const over90 = list.reduce((sum, debtor) => sum + debtor.buckets[3], 0);
    const concentrated = list.filter((debtor) => debtor.share >= .15 && debtor.openBalance > 0);
    const slow = list.filter((debtor) => (debtor.daysToPay ?? 0) > SLOW_DAYS && debtor.paidCount >= 2);
    const disputed = list.reduce((sum, debtor) => sum + debtor.disputedCount, 0);
    const attention = list.filter((debtor) => attentionScore(debtor) > 0);
    return { open, over90, over90Share: open ? over90 / open : 0, concentrated, slow, disputed, attention };
  }, [data]);

  const header = (key: SortKey, label: string, num = true) => <th className={num ? styles.num : ''}>
    <button type="button" className={sort.key === key ? styles.sortActive : ''} onClick={() => setSort((current) => ({ key, desc: current.key === key ? !current.desc : key !== 'name' }))}>
      {label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </button>
  </th>;

  return <main className={`opsShell ${styles.page}`}>
    <OpsSidebar active="debtors" />
    <section className="opsContent">
      <header className={styles.header}>
        <div>
          <div className={styles.meta}><span className="eyebrow">Portfolio risk</span>{data?.demo ? <DemoBadge /> : <span className={styles.live}>Live FactorCloud data</span>}</div>
          <h1>Debtors</h1>
          <p>Focus on the account debtors that can change a funding decision: concentration, aging, payment speed, and disputes.</p>
        </div>
        <div className={styles.headerActions}>
          <a href="/ops/reports">Full reports</a>
          <button onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </header>

      {error && <div className={styles.alert}><strong>Could not load debtors.</strong> {error}</div>}
      {data && !data.complete && <div className={styles.alert}><strong>Totals may be incomplete.</strong> {data.incompleteReason}</div>}
      {loading && !data && <DashboardSkeleton metrics={4} />}

      {data && <>
        <section className={styles.metricGrid}>
          <Metric label="Open exposure" value={compactMoney(totals.open)} detail={`${data.debtors.filter((d) => d.openBalance > 0).length} debtors with open funded invoices`} />
          <Metric label="90+ past due" value={compactMoney(totals.over90)} detail={`${Math.round(totals.over90Share * 100)}% of open exposure`} tone={totals.over90 > 0 ? 'danger' : 'good'} />
          <Metric label="Concentration alerts" value={totals.concentrated.length} detail="Debtors at 15%+ of open exposure" tone={totals.concentrated.length ? 'review' : 'good'} />
          <Metric label="Payment issues" value={totals.slow.length + totals.disputed} detail={`${totals.slow.length} slow payer${totals.slow.length === 1 ? '' : 's'} · ${totals.disputed} dispute${totals.disputed === 1 ? '' : 's'}`} tone={totals.slow.length || totals.disputed ? 'review' : 'good'} />
        </section>

        <section className={styles.card}>
          <div className={styles.tableHeader}>
            <div><span>Risk watch</span><h2>{totals.attention.length} debtor{totals.attention.length === 1 ? '' : 's'} need attention</h2><p>Operational view only. Charts and broader portfolio analysis live in Reports.</p></div>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search debtor or client" />
          </div>

          {rows.length ? <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr>{header('name', 'Debtor', false)}{header('openBalance', 'Exposure')}<th>Signals</th>{header('over90', '90+')} {header('daysToPay', 'Avg pay')}{header('oldestOpenDays', 'Oldest')}</tr></thead>
              <tbody>
                {rows.map((debtor) => {
                  const signals = debtorSignals(debtor);
                  return <tr key={debtor.debtorId}>
                    <td>
                      <div className={styles.debtorName}><strong>{debtor.name}</strong><span>{debtor.clientCount ? `${debtor.clientCount} client${debtor.clientCount === 1 ? '' : 's'}${debtor.topClient ? ` · mostly ${debtor.topClient}` : ''}` : 'No open invoices'}</span></div>
                    </td>
                    <td className={styles.num}><strong>{money(debtor.openBalance)}</strong><small>{Math.round(debtor.share * 100)}% of portfolio · {debtor.openCount} inv</small></td>
                    <td><div className={styles.flags}>
                      {!signals.length && <StatusFlag level="GOOD">Clear</StatusFlag>}
                      {debtor.share >= .15 && <StatusFlag level={debtor.share >= .25 ? 'HIGH' : 'REVIEW'}>{Math.round(debtor.share * 100)}% concentration</StatusFlag>}
                      {debtor.buckets[3] > 0 && <StatusFlag level="HIGH">90+ past due</StatusFlag>}
                      {(debtor.daysToPay ?? 0) > SLOW_DAYS && debtor.paidCount >= 2 && <StatusFlag level="REVIEW">Slow payer</StatusFlag>}
                      {debtor.disputedCount > 0 && <StatusFlag level="REVIEW">{debtor.disputedCount} disputed</StatusFlag>}
                    </div></td>
                    <td className={styles.num}>{debtor.buckets[3] ? money(debtor.buckets[3]) : '–'}</td>
                    <td className={styles.num}>{debtor.daysToPay == null ? '–' : `${Math.round(debtor.daysToPay)}d`}</td>
                    <td className={styles.num}>{debtor.oldestOpenDays == null ? '–' : `${debtor.oldestOpenDays}d`}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div> : <div className={styles.empty}>{query ? 'No debtors match that search.' : 'No debtors yet.'}</div>}
        </section>

        <p className={styles.note}>This screen is for funding-risk triage. The next useful addition is FactorCloud debtor credit status/headroom so staff can see whether a debtor is eligible before funding. Exposure charts and aging analysis remain in Reports.</p>
      </>}
    </section>
  </main>;
}

function debtorSignals(debtor: DebtorSummary): string[] {
  const signals: string[] = [];
  if (debtor.share >= .15) signals.push('concentration');
  if (debtor.buckets[3] > 0) signals.push('90+');
  if ((debtor.daysToPay ?? 0) > SLOW_DAYS && debtor.paidCount >= 2) signals.push('slow');
  if (debtor.disputedCount > 0) signals.push('disputed');
  return signals;
}

function attentionScore(debtor: DebtorSummary): number {
  let score = 0;
  if (debtor.share >= .25) score += 4;
  else if (debtor.share >= .15) score += 2;
  if (debtor.buckets[3] > 0) score += 4;
  if ((debtor.daysToPay ?? 0) > SLOW_DAYS && debtor.paidCount >= 2) score += 2;
  if (debtor.disputedCount > 0) score += 2;
  if ((debtor.oldestOpenDays ?? 0) > 60) score += 1;
  return score;
}

function Metric({ label, value, detail, tone = '' }: { label: string; value: React.ReactNode; detail: string; tone?: string }) {
  return <div className={styles.metric} data-tone={tone}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
