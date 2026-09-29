'use client';

import { useEffect, useMemo, useState } from 'react';
import { OpsSignOut } from '../../components/OpsSignOut';
import { ViewSwitch } from '@/app/components/ViewSwitch';
import { DemoBadge } from '@/app/components/DemoBadge';
import { AgingBars, CountUp, DashboardSkeleton, ExposureTreemap, StatusFlag, VIZ, VizEmpty, compactMoney, money } from '@/app/components/CommandCharts';
import type { AgingSummary, ExposureItem } from '@/lib/analytics';
import type { DebtorSummary } from '@/lib/debtors';

type Response = { today: string; debtors: DebtorSummary[]; aging: AgingSummary; exposure: ExposureItem[]; complete: boolean; incompleteReason: string | null; demo?: boolean; error?: string };
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
        const x = value(a); const y = value(b);
        const cmp = typeof x === 'string' ? String(x).localeCompare(String(y)) : (x as number) - (y as number);
        return sort.desc ? -cmp : cmp;
      });
  }, [data, query, sort]);

  const totals = useMemo(() => {
    const list = data?.debtors ?? [];
    const open = list.reduce((s, d) => s + d.openBalance, 0);
    const over90 = list.reduce((s, d) => s + d.buckets[3], 0);
    const slow = list.filter((d) => (d.daysToPay ?? 0) > SLOW_DAYS && d.paidCount >= 2);
    return { withOpen: list.filter((d) => d.openBalance > 0).length, open, over90, over90Share: open ? over90 / open : 0, slow, disputed: list.reduce((s, d) => s + d.disputedCount, 0) };
  }, [data]);

  const header = (key: SortKey, label: string, num = true) => <th className={num ? 'num' : ''}>
    <button type="button" className={`sortHeader ${sort.key === key ? 'active' : ''}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
      {label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </button>
  </th>;

  return <main className="opsShell dashboardPage">
    <aside className="opsSidebar">
      <a className="opsBrand" href="/ops"><img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" /></a>
      <div className="opsRole">Factor Operations</div>
      <ViewSwitch current="staff" />
      <nav className="opsNav">
        <a href="/ops">Overview</a>
        <a href="/ops#clients">Clients</a>
        <a className="active" href="/ops/debtors">Debtors</a>
        <a href="/ops/reviews">Review queue</a>
        <a href="/ops/funding">Funding</a>
        <a href="/ops/rules">Funding rules</a>
        <a href="/connection">Connection check</a>
      </nav>
      <div className="opsSidebarFooter"><strong>Internal view</strong><span>Factor-wide access</span><OpsSignOut /></div>
    </aside>

    <section className="opsContent">
      <header className="opsHeader dashboardHero opsDashboardHero">
        <div>
          <div className="dashboardHeroMeta"><span className="eyebrow">Factor operations</span>{data?.demo ? <DemoBadge /> : <span className="dashLiveBadge"><i />Live FactorCloud data</span>}</div>
          <h1>Debtors</h1>
          <p>Who owes the most across all your clients, how old it is, and how fast each debtor pays.</p>
        </div>
        <button className="small opsRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
      </header>

      {error && <div className="attentionSummary fail"><strong>Could not load debtors</strong><span>{error}</span></div>}
      {data && !data.complete && <div className="attentionSummary review"><strong>Totals may be incomplete</strong><span>{data.incompleteReason}</span></div>}
      {loading && !data && <DashboardSkeleton metrics={4} />}

      {data && <>
        <section className="dashMetricGrid debtorMetrics">
          <Metric label="Open with debtors" value={<CountUp value={totals.open} format={compactMoney} />} detail={`${totals.withOpen} debtors owe on funded invoices`} />
          <Metric label="Past 90 days" value={<CountUp value={totals.over90} format={compactMoney} />} detail={`${Math.round(totals.over90Share * 100)}% of open balance`} tone={totals.over90Share > 0.05 ? 'review' : 'good'} />
          <Metric label="Slow payers" value={<CountUp value={totals.slow.length} />} detail={`Pay in over ${SLOW_DAYS} days on average`} tone={totals.slow.length ? 'review' : 'good'} />
          <Metric label="Disputed invoices" value={<CountUp value={totals.disputed} />} detail="Open and marked disputed" tone={totals.disputed ? 'bad' : 'good'} />
        </section>

        <section className="dashBoard">
          <section className="dashCard dashSpan7"><div className="dashCardHeader"><div><span>Exposure</span><h2>Open balance by debtor</h2></div></div>
            <div className="dashCardBody"><ExposureTreemap items={data.exposure} noun="debtor" /></div></section>
          <section className="dashCard dashSpan5"><div className="dashCardHeader"><div><span>Receivables</span><h2>How old it is</h2></div></div>
            <div className="dashCardBody"><AgingBars aging={data.aging} /></div></section>

          <section className="dashCard dashSpan12">
            <div className="dashCardHeader clientsCardHeader">
              <div><span>All debtors</span><h2>{rows.length} debtor{rows.length === 1 ? '' : 's'}</h2><p>Click a column to sort. Days to pay covers invoices paid in the last 180 days.</p></div>
              <label className="opsSearch"><span>Search</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Debtor or client" /></label>
            </div>
            {rows.length ? <div className="batchTableWrap">
              <table className="batchTable opsTable debtorTable">
                <thead><tr>{header('name', 'Debtor', false)}{header('openBalance', 'Open')}<th>Age of open balance</th>{header('over90', '90+')}{header('daysToPay', 'Days to pay')}{header('oldestOpenDays', 'Oldest')}{header('recentVolume', '90-day volume')}</tr></thead>
                <tbody>
                  {rows.map((d) => <tr key={d.debtorId}>
                    <td><div className="opsClientName"><strong>{d.name}</strong><span>{d.clientCount ? `${d.clientCount} client${d.clientCount === 1 ? '' : 's'}${d.topClient ? ` · mostly ${d.topClient}` : ''}` : 'No open invoices'}</span></div>
                      <div className="debtorFlags">
                        {d.share >= 0.15 && <StatusFlag level={d.share >= 0.25 ? 'HIGH' : 'REVIEW'}>{Math.round(d.share * 100)}% of exposure</StatusFlag>}
                        {d.buckets[3] > 0 && <StatusFlag level="HIGH">90+ days</StatusFlag>}
                        {(d.daysToPay ?? 0) > SLOW_DAYS && d.paidCount >= 2 && <StatusFlag level="REVIEW">Slow payer</StatusFlag>}
                        {d.disputedCount > 0 && <StatusFlag level="REVIEW">{d.disputedCount} disputed</StatusFlag>}
                      </div></td>
                    <td className="num"><strong>{money(d.openBalance)}</strong><small className="cellSub">{Math.round(d.share * 100)}% · {d.openCount} inv</small></td>
                    <td><AgeStrip buckets={d.buckets} /></td>
                    <td className="num">{d.buckets[3] ? money(d.buckets[3]) : '–'}</td>
                    <td className="num">{d.daysToPay == null ? '–' : `${Math.round(d.daysToPay)}d`}</td>
                    <td className="num">{d.oldestOpenDays == null ? '–' : `${d.oldestOpenDays}d`}</td>
                    <td className="num">{compactMoney(d.recentVolume)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div> : <VizEmpty title={query ? 'No matching debtors' : 'No debtors yet'} detail={query ? 'Try another name.' : 'Debtors appear once invoices are funded.'} />}
          </section>
        </section>
        <p className="portalDataNote opsPortfolioNote">Built from FactorCloud invoices across all clients. Open balance counts funded invoices not yet paid; rejected and canceled invoices are left out.</p>
      </>}
    </section>
  </main>;
}

function Metric({ label, value, detail, tone = '' }: { label: string; value: React.ReactNode; detail: string; tone?: string }) {
  return <div className={`dashMetric ${tone}`}><span className="dashMetricLabel">{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function AgeStrip({ buckets }: { buckets: number[] }) {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return <span className="cellSub">–</span>;
  const labels = ['0–30', '31–60', '61–90', '90+'];
  return <div className="ageStrip" title={buckets.map((b, i) => `${labels[i]} days: ${money(b)}`).join('\n')}>
    {buckets.map((b, i) => b > 0 && <span key={i} style={{ flexGrow: b, background: VIZ.aging[i] }} />)}
  </div>;
}
