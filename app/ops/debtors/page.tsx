'use client';

import { useEffect, useMemo, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { DemoBadge } from '@/app/components/DemoBadge';
import { AgingBars, DashboardSkeleton, ExposureTreemap, StatusFlag, VIZ, compactMoney, money } from '@/app/components/CommandCharts';
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

type SortKey = 'openBalance' | 'over90' | 'daysToPay' | 'oldestOpenDays' | 'recentVolume' | 'name';
const SLOW_DAYS = 55;

export default function DebtorsPage() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'openBalance', desc: true });

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
    const value = (d: DebtorSummary): number | string => sort.key === 'over90' ? d.buckets[3] : sort.key === 'name' ? d.name.toLowerCase() : d[sort.key] ?? -1;
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
    const slow = list.filter((debtor) => (debtor.daysToPay ?? 0) > SLOW_DAYS && debtor.paidCount >= 2);
    return {
      withOpen: list.filter((debtor) => debtor.openBalance > 0).length,
      open,
      over90,
      over90Share: open ? over90 / open : 0,
      slow,
      disputed: list.reduce((sum, debtor) => sum + debtor.disputedCount, 0),
    };
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
          <div className={styles.meta}><span className="eyebrow">Portfolio</span>{data?.demo ? <DemoBadge /> : <span className={styles.live}>Live FactorCloud data</span>}</div>
          <h1>Debtors</h1>
          <p>See who owes the portfolio, how old the exposure is, and where payment behavior creates risk.</p>
        </div>
        <div className={styles.headerActions}>
          <a href="/ops/reports">Reports</a>
          <button onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </header>

      {error && <div className={styles.alert}><strong>Could not load debtors.</strong> {error}</div>}
      {data && !data.complete && <div className={styles.alert}><strong>Totals may be incomplete.</strong> {data.incompleteReason}</div>}
      {loading && !data && <DashboardSkeleton metrics={4} />}

      {data && <>
        <section className={styles.metricGrid}>
          <Metric label="Open with debtors" value={compactMoney(totals.open)} detail={`${totals.withOpen} debtors owe on funded invoices`} />
          <Metric label="Past 90 days" value={compactMoney(totals.over90)} detail={`${Math.round(totals.over90Share * 100)}% of open balance`} tone={totals.over90Share > .05 ? 'review' : 'good'} />
          <Metric label="Slow payers" value={totals.slow.length} detail={`Average payment over ${SLOW_DAYS} days`} tone={totals.slow.length ? 'review' : 'good'} />
          <Metric label="Disputed invoices" value={totals.disputed} detail="Open and marked disputed" tone={totals.disputed ? 'danger' : 'good'} />
        </section>

        <section className={styles.chartGrid}>
          <div className={styles.card}>
            <CardHeader eyebrow="Exposure" title="Open balance by debtor" detail="Largest concentrations across all clients" />
            <div className={styles.chartBody}><ExposureTreemap items={data.exposure} noun="debtor" /></div>
          </div>
          <div className={styles.card}>
            <CardHeader eyebrow="Receivables" title="How old it is" detail="Aging of currently open funded invoices" />
            <div className={styles.chartBody}><AgingBars aging={data.aging} /></div>
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.tableHeader}>
            <div><span>All debtors</span><h2>{rows.length} debtor{rows.length === 1 ? '' : 's'}</h2><p>Sort by exposure, age, payment speed, or recent volume.</p></div>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search debtor or client" />
          </div>

          {rows.length ? <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr>{header('name', 'Debtor', false)}{header('openBalance', 'Open')}<th>Age mix</th>{header('over90', '90+')}{header('daysToPay', 'Days to pay')}{header('oldestOpenDays', 'Oldest')}{header('recentVolume', '90-day volume')}</tr></thead>
              <tbody>
                {rows.map((debtor) => <tr key={debtor.debtorId}>
                  <td>
                    <div className={styles.debtorName}><strong>{debtor.name}</strong><span>{debtor.clientCount ? `${debtor.clientCount} client${debtor.clientCount === 1 ? '' : 's'}${debtor.topClient ? ` · mostly ${debtor.topClient}` : ''}` : 'No open invoices'}</span></div>
                    <div className={styles.flags}>
                      {debtor.share >= .15 && <StatusFlag level={debtor.share >= .25 ? 'HIGH' : 'REVIEW'}>{Math.round(debtor.share * 100)}% exposure</StatusFlag>}
                      {debtor.buckets[3] > 0 && <StatusFlag level="HIGH">90+ days</StatusFlag>}
                      {(debtor.daysToPay ?? 0) > SLOW_DAYS && debtor.paidCount >= 2 && <StatusFlag level="REVIEW">Slow payer</StatusFlag>}
                      {debtor.disputedCount > 0 && <StatusFlag level="REVIEW">{debtor.disputedCount} disputed</StatusFlag>}
                    </div>
                  </td>
                  <td className={styles.num}><strong>{money(debtor.openBalance)}</strong><small>{Math.round(debtor.share * 100)}% · {debtor.openCount} inv</small></td>
                  <td><AgeStrip buckets={debtor.buckets} /></td>
                  <td className={styles.num}>{debtor.buckets[3] ? money(debtor.buckets[3]) : '–'}</td>
                  <td className={styles.num}>{debtor.daysToPay == null ? '–' : `${Math.round(debtor.daysToPay)}d`}</td>
                  <td className={styles.num}>{debtor.oldestOpenDays == null ? '–' : `${debtor.oldestOpenDays}d`}</td>
                  <td className={styles.num}>{compactMoney(debtor.recentVolume)}</td>
                </tr>)}
              </tbody>
            </table>
          </div> : <div className={styles.empty}>{query ? 'No debtors match that search.' : 'No debtors yet.'}</div>}
        </section>

        <p className={styles.note}>Built from FactorCloud invoices across all clients. Open balance counts funded invoices not yet paid; rejected and canceled invoices are excluded.</p>
      </>}
    </section>
  </main>;
}

function Metric({ label, value, detail, tone = '' }: { label: string; value: React.ReactNode; detail: string; tone?: string }) {
  return <div className={styles.metric} data-tone={tone}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function CardHeader({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return <div className={styles.cardHeader}><span>{eyebrow}</span><h2>{title}</h2><p>{detail}</p></div>;
}

function AgeStrip({ buckets }: { buckets: number[] }) {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return <span className={styles.dash}>–</span>;
  const labels = ['0–30', '31–60', '61–90', '90+'];
  return <div className={styles.ageStrip} title={buckets.map((bucket, index) => `${labels[index]} days: ${money(bucket)}`).join('\n')}>
    {buckets.map((bucket, index) => bucket > 0 && <span key={index} style={{ flexGrow: bucket, background: VIZ.aging[index] }} />)}
  </div>;
}
