'use client';

import { useEffect, useMemo, useState } from 'react';
import { PortalNav } from '@/app/components/PortalNav';

type RiskRecord = {
  id: string;
  invoiceNumber: string | null;
  companyDebtorId: string | null;
  invoiceAmount: number | null;
  invoiceDate: string | null;
  status: string | null;
};

type Concentration = {
  debtorId: string;
  debtorName: string;
  amount: number;
  invoiceCount: number;
  share: number;
  level: 'NORMAL' | 'REVIEW' | 'HIGH';
};

type Alert = {
  id: string;
  level: 'INFO' | 'REVIEW' | 'HIGH';
  title: string;
  detail: string;
};

type RiskResponse = {
  totalAmount: number;
  invoiceCount: number;
  last7Amount: number;
  prior28Amount: number;
  volumeRatio: number | null;
  concentrations: Concentration[];
  alerts: Alert[];
  records: RiskRecord[];
  thresholds: {
    concentrationReview: number;
    concentrationHigh: number;
    volumeSpikeRatio: number;
  };
  source: {
    clientId: string;
    clientName?: string;
    returnedInvoiceCount: number;
    clientInvoiceCount: number;
    note: string;
  };
  error?: string;
};

export default function RiskPage() {
  const [data, setData] = useState<RiskResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/risk', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load alerts.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const recent = useMemo(() => (data?.records ?? [])
    .slice()
    .sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? '')))
    .slice(0, 20), [data]);

  return (
    <main className="shell batchShell portalToolShell">
      <PortalNav active="risk" />
      <section className="hero portalSubHero">
        <div>
          <span className="eyebrow">FactorCloud Client Portal</span>
          <h1>Alerts</h1>
          <p>Keep an eye on debtor concentration and unusual invoice-volume changes without digging through reports.</p>
        </div>
        <div className="badges"><span className="prototype">Read only</span><span className="prototype">V1 monitoring</span></div>
      </section>

      {error && <div className="attentionSummary fail"><strong>Could not load alerts</strong><span>{error}</span></div>}

      <section className="topbar clientConnectionBar">
        <div><strong>Source</strong><span>FactorCloud invoice activity</span></div>
        <div><strong>Monitoring</strong><span>Concentration + volume</span></div>
        <button className="small riskRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
      </section>

      {loading && !data ? <section className="card"><h2>Loading alerts...</h2></section> : data && <>
        <section className="batchStats riskStats">
          <Stat label="Invoice activity" value={money(data.totalAmount)} />
          <Stat label="Invoices" value={data.invoiceCount} />
          <Stat label="Last 7 days" value={money(data.last7Amount)} />
          <Stat label="Prior 28 days" value={money(data.prior28Amount)} />
          <Stat label="Volume pace" value={data.volumeRatio == null ? 'No baseline' : `${data.volumeRatio.toFixed(1)}x`} tone={data.volumeRatio != null && data.volumeRatio >= data.thresholds.volumeSpikeRatio ? 'review' : ''} />
          <Stat label="Active alerts" value={data.alerts.length} tone={data.alerts.some((a) => a.level === 'HIGH') ? 'fail' : data.alerts.length ? 'review' : 'pass'} />
        </section>

        <section className="card riskAlertsCard">
          <div className="riskSectionHeader"><div><span className="panelKicker">Needs attention</span><h2>Current alerts</h2><p>V1 signals based on the FactorCloud invoice data we can currently retrieve.</p></div><span className="prototype">Warning ≥ {Math.round(data.thresholds.concentrationReview * 100)}% · High ≥ {Math.round(data.thresholds.concentrationHigh * 100)}%</span></div>
          {!data.alerts.length ? <div className="attentionSummary pass"><strong>All clear</strong><span>No concentration or volume threshold is currently triggered.</span></div> : <div className="riskAlertList">{data.alerts.map((alert) => <div className={`riskAlert ${alert.level.toLowerCase()}`} key={alert.id}><strong>{alert.title}</strong><span>{alert.detail}</span></div>)}</div>}
        </section>

        <section className="card batchTableCard">
          <div className="batchTableHeader"><div><h2>Debtor concentration</h2><p>Share of invoice amount in the currently retrieved dataset.</p></div></div>
          <div className="batchTableWrap">
            <table className="batchTable riskTable">
              <thead><tr><th>Debtor</th><th>Invoices</th><th>Amount</th><th>Share</th><th>Signal</th></tr></thead>
              <tbody>
                {data.concentrations.map((row) => <tr key={row.debtorId}><td><strong>{row.debtorName}</strong></td><td>{row.invoiceCount}</td><td>{money(row.amount)}</td><td>{Math.round(row.share * 100)}%</td><td><span className={`pill ${row.level === 'NORMAL' ? 'pass' : row.level === 'REVIEW' ? 'review' : 'fail'}`}>{row.level === 'NORMAL' ? 'NORMAL' : row.level}</span></td></tr>)}
                {!data.concentrations.length && <tr><td colSpan={5}>No debtor concentration data is available yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card batchTableCard">
          <div className="batchTableHeader"><div><h2>Recent invoice activity</h2><p>Underlying records used by the v1 monitoring signals.</p></div><a className="modeLink" href="/invoices">Open invoices</a></div>
          <div className="batchTableWrap">
            <table className="batchTable riskTable">
              <thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th><th>Debtor ID</th></tr></thead>
              <tbody>{recent.map((record) => <tr key={record.id}><td><strong>{record.invoiceNumber || record.id}</strong></td><td>{record.invoiceDate || '-'}</td><td>{record.invoiceAmount == null ? '-' : money(record.invoiceAmount)}</td><td>{prettyStatus(record.status || '-')}</td><td className="riskId">{record.companyDebtorId || '-'}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <p className="portalDataNote">V1 alert thresholds are configurable per client. Before using this as a formal credit or funding control, we still need to map true open A/R, balances, and the final business rules from FactorCloud.</p>
      </>}
    </main>
  );
}

function Stat({ label, value, tone = '' }: { label: string; value: string | number; tone?: string }) {
  return <div className={`batchStat ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function prettyStatus(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
