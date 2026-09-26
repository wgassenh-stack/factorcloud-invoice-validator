'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { OpsSignOut } from '../../../components/OpsSignOut';
import { ViewSwitch } from '@/app/components/ViewSwitch';

type InvoiceRecord = {
  id: string;
  invoiceNumber: string | null;
  companyDebtorId: string | null;
  invoiceAmount: number | null;
  invoiceDate: string | null;
  status: string | null;
};

type ClientDetailResponse = {
  client: { id: string; name: string; code: string | null; phone: string | null; city: string | null; state: string | null };
  records: InvoiceRecord[];
  debtorNames: Record<string, string>;
  summary: {
    totalAmount: number;
    invoiceCount: number;
    last7Amount: number;
    volumeRatio: number | null;
    concentrations: Array<{ debtorId: string; debtorName: string; amount: number; invoiceCount: number; share: number; level: 'NORMAL' | 'REVIEW' | 'HIGH' }>;
    alerts: Array<{ id: string; level: 'INFO' | 'REVIEW' | 'HIGH'; title: string; detail: string }>;
  };
  source: { note: string };
  error?: string;
};

export default function FactorClientDetailPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params.clientId;
  const [data, setData] = useState<ClientDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/ops/clients/${encodeURIComponent(clientId)}`, { cache: 'no-store' });
      const body = await res.json() as ClientDetailResponse;
      if (!res.ok) throw new Error(body.error || 'Could not load client details.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [clientId]);

  const recent = useMemo(() => (data?.records ?? []).slice().sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? ''))).slice(0, 12), [data]);
  const topDebtor = data?.summary.concentrations[0];

  return <main className="opsShell">
    <aside className="opsSidebar">
      <a className="opsBrand" href="/ops"><img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" /></a>
      <div className="opsRole">Factor Operations</div>
      <ViewSwitch current="staff" />
      <nav className="opsNav">
        <a href="/ops">Overview</a>
        <a className="active" href="/ops">Clients</a>
        <a href="/ops/debtors">Debtors</a>
        <a href="/ops/reviews">Review queue</a>
        <a href="/connection">Connection check</a>
      </nav>
      <div className="opsSidebarFooter"><strong>Internal view</strong><span>Factor-wide access</span><OpsSignOut /></div>
    </aside>

    <section className="opsContent">
      <a className="opsBack" href="/ops">← All clients</a>
      <header className="opsHeader">
        <div>
          <span className="eyebrow">Client account</span>
          <h1>{data?.client.name || 'Client'}</h1>
          <p>{data ? [data.client.code, data.client.city, data.client.state].filter(Boolean).join(' · ') || data.client.id : 'Loading FactorCloud client data...'}</p>
        </div>
        <div className="opsHeaderActions">
          <a className="secondaryLink" href={`/statements?client=${encodeURIComponent(clientId)}`}>Statement</a>
          <button className="small opsRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
        </div>
      </header>

      {error && <div className="attentionSummary fail"><strong>Could not load client</strong><span>{error}</span></div>}

      {data && <>
        <section className="opsMetrics">
          <Metric label="Invoices in retrieved data" value={data.summary.invoiceCount} />
          <Metric label="Invoice amount" value={money(data.summary.totalAmount)} />
          <Metric label="Last 7 days" value={money(data.summary.last7Amount)} detail={data.summary.volumeRatio == null ? 'No prior baseline yet' : `${data.summary.volumeRatio.toFixed(1)}x prior weekly pace`} />
          <Metric label="Top debtor concentration" value={topDebtor ? `${Math.round(topDebtor.share * 100)}%` : '-'} detail={topDebtor?.debtorName} />
        </section>

        <div className="warning opsDataNote">{data.source.note}</div>

        <section className="opsClientGrid">
          <div className="opsPanel">
            <div className="opsPanelHeader"><div><h2>Alerts</h2><p>Current threshold-based signals for this client.</p></div></div>
            <div className="opsAlertList">
              {data.summary.alerts.map((alert) => <div className={`opsAlert ${alert.level.toLowerCase()}`} key={alert.id}><strong>{alert.title}</strong><span>{alert.detail}</span></div>)}
              {!data.summary.alerts.length && <div className="portalEmpty"><strong>No current alerts</strong><span>No concentration or volume threshold is triggered in the retrieved data.</span></div>}
            </div>
          </div>

          <div className="opsPanel">
            <div className="opsPanelHeader"><div><h2>Debtor concentration</h2><p>Largest debtor shares in the retrieved invoice set.</p></div></div>
            <div className="opsConcentrationList">
              {data.summary.concentrations.slice(0, 6).map((row) => <div key={row.debtorId}><div><strong>{row.debtorName}</strong><span>{row.invoiceCount} invoices · {money(row.amount)}</span></div><b>{Math.round(row.share * 100)}%</b></div>)}
              {!data.summary.concentrations.length && <div className="portalEmpty"><strong>No debtor data yet</strong></div>}
            </div>
          </div>
        </section>

        <section className="opsPanel opsRecentPanel">
          <div className="opsPanelHeader"><div><h2>Recent invoices</h2><p>Latest invoice activity for this client.</p></div></div>
          <div className="batchTableWrap">
            <table className="batchTable opsTable">
              <thead><tr><th>Invoice</th><th>Debtor</th><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {recent.map((record) => <tr key={record.id}><td><strong>{record.invoiceNumber || record.id.slice(0, 8)}</strong></td><td>{record.companyDebtorId ? data.debtorNames[record.companyDebtorId] || record.companyDebtorId : '-'}</td><td>{record.invoiceDate || '-'}</td><td>{record.invoiceAmount == null ? '-' : money(record.invoiceAmount)}</td><td>{pretty(record.status || 'Unknown')}</td></tr>)}
                {!recent.length && <tr><td colSpan={5}>No invoices found for this client.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </>}
    </section>
  </main>;
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return <div className="opsMetric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function pretty(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
