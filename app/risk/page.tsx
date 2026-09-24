'use client';

import { useEffect, useMemo, useState } from 'react';

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
      if (!res.ok) throw new Error(body.error || 'Could not load FactorCloud risk data.');
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
    <main className="shell batchShell">
      <section className="hero">
        <div>
          <span className="eyebrow">FactorCloud Labs</span>
          <h1>Risk Monitor</h1>
          <p>Read-only pilot for concentration alerts and invoice-volume spikes using FactorCloud invoice data.</p>
        </div>
        <div className="badges">
          <a className="modeLink" href="/">Single packet</a>
          <a className="modeLink" href="/batch">Batch intake</a>
          <span className="prototype activeMode">Risk monitor</span>
        </div>
      </section>

      {error && <div className="attentionSummary fail"><strong>Could not load risk data</strong><span>{error}</span></div>}

      <section className="topbar">
        <div><strong>Source</strong><span>FactorCloud invoices</span></div>
        <div><strong>Mode</strong><span>Read only</span></div>
        <button className="small riskRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
      </section>

      {loading && !data ? <section className="card"><h2>Loading FactorCloud data...</h2></section> : data && <>
        <section className="batchStats riskStats">
          <Stat label="Invoice amount" value={money(data.totalAmount)} />
          <Stat label="Invoices" value={data.invoiceCount} />
          <Stat label="Last 7 days" value={money(data.last7Amount)} />
          <Stat label="Prior 28 days" value={money(data.prior28Amount)} />
          <Stat label="Volume pace" value={data.volumeRatio == null ? 'No baseline' : `${data.volumeRatio.toFixed(1)}x`} tone={data.volumeRatio != null && data.volumeRatio >= data.thresholds.volumeSpikeRatio ? 'review' : ''} />
          <Stat label="Alerts" value={data.alerts.length} tone={data.alerts.some((a) => a.level === 'HIGH') ? 'fail' : data.alerts.length ? 'review' : 'pass'} />
        </section>

        <div className="warning">{data.source.note}</div>

        <section className="card riskAlertsCard">
          <div className="riskSectionHeader"><div><h2>Alerts</h2><p>Threshold-based signals, not credit decisions.</p></div><span className="prototype">Review ≥ {Math.round(data.thresholds.concentrationReview * 100)}% · High ≥ {Math.round(data.thresholds.concentrationHigh * 100)}%</span></div>
          {!data.alerts.length ? <div className="attentionSummary pass"><strong>No current pilot alerts</strong><span>No concentration or volume-spike threshold was triggered by the retrieved invoice data.</span></div> : <div className="riskAlertList">{data.alerts.map((alert) => <div className={`riskAlert ${alert.level.toLowerCase()}`} key={alert.id}><strong>{alert.title}</strong><span>{alert.detail}</span></div>)}</div>}
        </section>

        <section className="card batchTableCard">
          <div className="batchTableHeader"><div><h2>Debtor concentration</h2><p>Share of invoice amount in the currently retrieved dataset.</p></div></div>
          <div className="batchTableWrap">
            <table className="batchTable riskTable">
              <thead><tr><th>Debtor</th><th>Invoices</th><th>Amount</th><th>Share</th><th>Signal</th></tr></thead>
              <tbody>
                {data.concentrations.map((row) => <tr key={row.debtorId}><td><strong>{row.debtorName}</strong></td><td>{row.invoiceCount}</td><td>{money(row.amount)}</td><td>{Math.round(row.share * 100)}%</td><td><span className={`pill ${row.level === 'NORMAL' ? 'pass' : row.level === 'REVIEW' ? 'review' : 'fail'}`}>{row.level}</span></td></tr>)}
                {!data.concentrations.length && <tr><td colSpan={5}>No debtor concentration data was available.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card batchTableCard">
          <div className="batchTableHeader"><div><h2>Recent invoice records</h2><p>Useful for checking what the pilot is actually reading from FactorCloud.</p></div><span className="prototype">{data.source.clientInvoiceCount} client records found</span></div>
          <div className="batchTableWrap">
            <table className="batchTable riskTable">
              <thead><tr><th>Invoice</th><th>Date</th><th>Amount</th><th>Status</th><th>Debtor ID</th></tr></thead>
              <tbody>{recent.map((record) => <tr key={record.id}><td><strong>{record.invoiceNumber || record.id}</strong></td><td>{record.invoiceDate || '-'}</td><td>{record.invoiceAmount == null ? '-' : money(record.invoiceAmount)}</td><td>{record.status || '-'}</td><td className="riskId">{record.companyDebtorId || '-'}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
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
