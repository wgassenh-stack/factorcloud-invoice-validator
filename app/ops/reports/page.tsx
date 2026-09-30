'use client';

import { useEffect, useMemo, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { DashboardSkeleton } from '@/app/components/CommandCharts';
import { DemoBadge } from '@/app/components/DemoBadge';
import styles from './Reports.module.css';

type ClientSummary = {
  clientId: string;
  clientName: string;
  invoiceCount: number;
  invoiceAmount: number;
  latestInvoiceDate: string | null;
};

type OpsData = {
  clients: ClientSummary[];
  totals: { clientCount: number; invoiceCount: number; invoiceAmount: number };
  portfolio: {
    topClientShare: number;
    arrivedToday: { available: boolean; count: number; amount: number };
  };
  analytics: {
    kpis: {
      openBalance: number;
      openCount: number;
      fundedLast30: number;
      collectedLast30: number;
      feesLast30: number;
      dsoLast90: number | null;
    };
    aging: { totals: number[]; openBalance: number; openCount: number };
  };
  demo?: boolean;
  source: { complete?: boolean; note: string };
};

type DebtorRow = {
  debtorId: string;
  name: string;
  openBalance: number;
  share: number;
  buckets: number[];
  daysToPay: number | null;
  oldestOpenDays: number | null;
  recentVolume: number;
};

type DebtorData = {
  debtors: DebtorRow[];
  complete: boolean;
  incompleteReason: string | null;
  demo?: boolean;
};

const AGING_LABELS = ['0–30', '31–60', '61–90', '90+'];

export default function ReportsPage() {
  const [ops, setOps] = useState<OpsData | null>(null);
  const [debtors, setDebtors] = useState<DebtorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [opsResponse, debtorResponse] = await Promise.all([
        fetch('/api/ops/clients', { cache: 'no-store' }),
        fetch('/api/ops/debtors', { cache: 'no-store' }),
      ]);
      const opsBody = await opsResponse.json() as OpsData & { error?: string };
      const debtorBody = await debtorResponse.json() as DebtorData & { error?: string };
      if (!opsResponse.ok) throw new Error(opsBody.error || 'Could not load portfolio reporting.');
      if (!debtorResponse.ok) throw new Error(debtorBody.error || 'Could not load debtor reporting.');
      setOps(opsBody);
      setDebtors(debtorBody);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const topClients = useMemo(() => [...(ops?.clients ?? [])].sort((a, b) => b.invoiceAmount - a.invoiceAmount).slice(0, 8), [ops]);
  const topDebtors = useMemo(() => [...(debtors?.debtors ?? [])].sort((a, b) => b.openBalance - a.openBalance).slice(0, 8), [debtors]);
  const maxClient = Math.max(1, ...topClients.map((client) => client.invoiceAmount));
  const maxDebtor = Math.max(1, ...topDebtors.map((debtor) => debtor.openBalance));
  const aging = ops?.analytics.aging.totals ?? [0, 0, 0, 0];
  const maxAging = Math.max(1, ...aging);
  const ninetyPlus = aging[3] ?? 0;

  return <main className={`opsShell ${styles.page}`}>
    <OpsSidebar active="reports" />
    <section className="opsContent">
      <header className={styles.header}>
        <div>
          <div className={styles.meta}><span className="eyebrow">Portfolio</span>{ops?.demo || debtors?.demo ? <DemoBadge /> : <span className={styles.live}>Live FactorCloud data</span>}</div>
          <h1>Reports</h1>
          <p>Portfolio-level reporting lives here so Overview can stay focused on the work that needs action.</p>
        </div>
        <button className={styles.refresh} onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh data'}</button>
      </header>

      {error && <div className={styles.alert}><strong>Could not load reports.</strong> {error}</div>}
      {ops?.source.complete === false && <div className={styles.alert}><strong>Portfolio data may be incomplete.</strong> {ops.source.note}</div>}
      {debtors && !debtors.complete && <div className={styles.alert}><strong>Debtor data may be incomplete.</strong> {debtors.incompleteReason}</div>}
      {loading && !ops && !debtors ? <DashboardSkeleton metrics={5} /> : <>
        <section className={styles.metricGrid}>
          <Metric label="Open A/R" value={money(ops?.analytics.kpis.openBalance ?? 0)} detail={`${ops?.analytics.kpis.openCount ?? 0} open invoices`} />
          <Metric label="Funded · 30d" value={money(ops?.analytics.kpis.fundedLast30 ?? 0)} detail="Funding volume" />
          <Metric label="Collected · 30d" value={money(ops?.analytics.kpis.collectedLast30 ?? 0)} detail="Cash collected" />
          <Metric label="Fees · 30d" value={money(ops?.analytics.kpis.feesLast30 ?? 0)} detail="Recorded factor fees" />
          <Metric label="DSO · 90d" value={ops?.analytics.kpis.dsoLast90 == null ? '—' : `${ops.analytics.kpis.dsoLast90.toFixed(1)}d`} detail="Days to collect" />
        </section>

        <section className={styles.gridTwo}>
          <div className={styles.card}>
            <CardHeader eyebrow="Receivables" title="A/R aging" detail={`${money(ninetyPlus)} is 90+ days old`} />
            <div className={styles.agingChart}>
              {aging.map((value, index) => <div className={styles.agingRow} key={AGING_LABELS[index]}>
                <span>{AGING_LABELS[index]}</span>
                <div><i style={{ width: `${Math.max(value ? 3 : 0, (value / maxAging) * 100)}%` }} data-old={index === 3} /></div>
                <strong>{money(value)}</strong>
              </div>)}
            </div>
          </div>

          <div className={styles.card}>
            <CardHeader eyebrow="Concentration" title="Top clients by invoice volume" detail={`${Math.round((ops?.portfolio.topClientShare ?? 0) * 100)}% held by the largest client`} />
            <div className={styles.barList}>
              {topClients.map((client) => <a href={`/ops/clients/${encodeURIComponent(client.clientId)}`} className={styles.barRow} key={client.clientId}>
                <span className={styles.barLabel}><strong>{client.clientName}</strong><small>{client.invoiceCount} invoices</small></span>
                <span className={styles.barTrack}><i style={{ width: `${Math.max(3, (client.invoiceAmount / maxClient) * 100)}%` }} /></span>
                <strong className={styles.barValue}>{money(client.invoiceAmount)}</strong>
              </a>)}
              {!topClients.length && <div className={styles.empty}>No client reporting data yet.</div>}
            </div>
          </div>
        </section>

        <section className={styles.gridTwo}>
          <div className={styles.card}>
            <CardHeader eyebrow="Exposure" title="Largest debtor balances" detail="Open funded invoices by debtor" action={<a href="/ops/debtors">Open debtors →</a>} />
            <div className={styles.barList}>
              {topDebtors.map((debtor) => <div className={styles.barRow} key={debtor.debtorId}>
                <span className={styles.barLabel}><strong>{debtor.name}</strong><small>{Math.round(debtor.share * 100)}% of open exposure</small></span>
                <span className={`${styles.barTrack} ${styles.debtorTrack}`}><i style={{ width: `${Math.max(3, (debtor.openBalance / maxDebtor) * 100)}%` }} /></span>
                <strong className={styles.barValue}>{money(debtor.openBalance)}</strong>
              </div>)}
              {!topDebtors.length && <div className={styles.empty}>No open debtor balances.</div>}
            </div>
          </div>

          <div className={styles.card}>
            <CardHeader eyebrow="Portfolio" title="At a glance" detail="Current loaded FactorCloud portfolio" />
            <div className={styles.snapshotGrid}>
              <Snapshot label="Clients" value={ops?.totals.clientCount ?? 0} />
              <Snapshot label="Invoices" value={ops?.totals.invoiceCount ?? 0} />
              <Snapshot label="Loaded volume" value={money(ops?.totals.invoiceAmount ?? 0)} />
              <Snapshot label="Arrived today" value={ops?.portfolio.arrivedToday.available ? ops.portfolio.arrivedToday.count : '—'} />
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <CardHeader eyebrow="Clients" title="Portfolio detail" detail="Largest clients first" />
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Client</th><th>Invoices</th><th>Loaded volume</th><th>Latest invoice</th><th /></tr></thead>
              <tbody>
                {[...(ops?.clients ?? [])].sort((a, b) => b.invoiceAmount - a.invoiceAmount).map((client) => <tr key={client.clientId}>
                  <td><strong>{client.clientName}</strong></td>
                  <td>{client.invoiceCount}</td>
                  <td>{money(client.invoiceAmount)}</td>
                  <td>{client.latestInvoiceDate ?? '—'}</td>
                  <td><a href={`/ops/clients/${encodeURIComponent(client.clientId)}`}>Open →</a></td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </section>
      </>}
    </section>
  </main>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function CardHeader({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: React.ReactNode }) {
  return <div className={styles.cardHeader}><div><span>{eyebrow}</span><h2>{title}</h2><p>{detail}</p></div>{action && <div className={styles.cardAction}>{action}</div>}</div>;
}

function Snapshot({ label, value }: { label: string; value: string | number }) {
  return <div className={styles.snapshot}><span>{label}</span><strong>{value}</strong></div>;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
}
