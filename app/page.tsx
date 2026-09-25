'use client';

import { useEffect, useMemo, useState } from 'react';
import { PortalNav } from '@/app/components/PortalNav';
import { portalConfig } from '@/lib/portal-config';

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

type PortalData = {
  totalAmount: number;
  invoiceCount: number;
  last7Amount: number;
  prior28Amount: number;
  volumeRatio: number | null;
  concentrations: Concentration[];
  alerts: Alert[];
  records: RiskRecord[];
  source: {
    clientId: string;
    clientName: string;
    returnedInvoiceCount: number;
    clientInvoiceCount: number;
    complete?: boolean;
    note: string;
  };
};

export default function ClientPortalHome() {
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/risk', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load your FactorCloud data.');
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
    .slice(0, 8), [data]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of data?.records ?? []) {
      const status = (record.status || 'Unknown').replaceAll('_', ' ');
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const debtorNames = useMemo(() => Object.fromEntries((data?.concentrations ?? []).map((row) => [row.debtorId, row.debtorName])), [data]);
  const topConcentration = data?.concentrations[0];

  return (
    <main className="portalShell">
      <PortalNav active="home" />

      <section className="portalWelcome">
        <div>
          <span className="eyebrow">FactorCloud Client Portal</span>
          <h1>{loading && !data ? 'Loading your account...' : `Welcome, ${data?.source.clientName ? shortName(data.source.clientName) : portalConfig.clientShortName}`}</h1>
          <p>Your invoices, funding activity, alerts, and submissions in one place.</p>
        </div>
        <div className="portalWelcomeActions">
          <a className="primaryLink" href="/submit">+ Submit invoice</a>
          <a className="secondaryLink" href="/invoices">View invoices</a>
        </div>
      </section>

      {data?.source.complete === false && <div className="attentionSummary review"><strong>Some invoices may be missing</strong><span>Not every invoice could be loaded from FactorCloud, so totals below may be incomplete. Try again shortly.</span></div>}
      {error && <div className="attentionSummary fail"><strong>Could not load FactorCloud data</strong><span>{error}</span><button className="small retryButton" onClick={() => void load()}>Try again</button></div>}

      {data && <>
        <section className="portalMetricGrid">
          <Metric label="Invoice activity" value={money(data.totalAmount)} detail={`${data.invoiceCount} invoice${data.invoiceCount === 1 ? '' : 's'} in current data`} />
          <Metric label="Last 7 days" value={money(data.last7Amount)} detail={data.volumeRatio == null ? 'Building a baseline' : `${data.volumeRatio.toFixed(1)}x prior weekly pace`} tone={data.volumeRatio != null && data.volumeRatio >= 1.5 ? 'review' : ''} />
          <Metric label="Top debtor share" value={topConcentration ? `${Math.round(topConcentration.share * 100)}%` : '-'} detail={topConcentration?.debtorName || 'No concentration data yet'} tone={topConcentration?.level === 'HIGH' ? 'fail' : topConcentration?.level === 'REVIEW' ? 'review' : ''} />
          <Metric label="Needs attention" value={data.alerts.length} detail={data.alerts.length ? 'Account alerts to review' : 'No current alerts'} tone={data.alerts.length ? 'review' : 'pass'} />
        </section>

        <section className="portalDashboardGrid">
          <div className="portalPanel portalActivityPanel">
            <div className="portalPanelHeader">
              <div><span className="panelKicker">Invoice activity</span><h2>Recent invoices</h2></div>
              <a href="/invoices">View all invoices</a>
            </div>

            {statusCounts.length > 0 && <div className="statusStrip">
              {statusCounts.slice(0, 4).map(([status, count]) => <div key={status}><strong>{count}</strong><span>{titleCase(status)}</span></div>)}
            </div>}

            <div className="portalInvoiceList">
              {recent.map((record) => <a className="portalInvoiceRow portalInvoiceLink" href={`/invoices?invoice=${encodeURIComponent(record.invoiceNumber || record.id)}`} key={record.id}>
                <div className="invoiceMark"><span>{statusInitial(record.status)}</span></div>
                <div className="invoiceIdentity">
                  <strong>Invoice {record.invoiceNumber || record.id.slice(0, 8)}</strong>
                  <span>{record.companyDebtorId ? debtorNames[record.companyDebtorId] || 'FactorCloud debtor' : 'Debtor unavailable'} · {record.invoiceDate || 'No date'}</span>
                </div>
                <span className={`portalStatus ${statusTone(record.status)}`}>{titleCase((record.status || 'Unknown').replaceAll('_', ' '))}</span>
                <strong className="invoiceAmount">{record.invoiceAmount == null ? '-' : money(record.invoiceAmount)}</strong>
              </a>)}
              {!recent.length && <div className="portalEmpty"><strong>No invoice activity yet</strong><span>Submit your first invoice to get started.</span></div>}
            </div>
          </div>

          <div className="portalSideColumn">
            <div className="portalPanel">
              <div className="portalPanelHeader"><div><span className="panelKicker">Attention</span><h2>Alerts</h2></div><a href="/risk">View all</a></div>
              <div className="portalAlertList">
                {data.alerts.slice(0, 4).map((alert) => <div className={`portalAlert ${alert.level.toLowerCase()}`} key={alert.id}><span className="alertDot"/><div><strong>{alert.title}</strong><span>{alert.detail}</span></div></div>)}
                {!data.alerts.length && <div className="portalEmpty compact"><strong>All clear</strong><span>No concentration or volume alert is currently triggered.</span></div>}
              </div>
            </div>

            <div className="portalPanel quickActionsPanel">
              <div className="portalPanelHeader"><div><span className="panelKicker">Quick actions</span><h2>What do you need?</h2></div></div>
              <a className="quickAction" href="/submit"><span className="quickIcon">↑</span><div><strong>Submit an invoice</strong><span>Upload and verify one funding packet</span></div><b>›</b></a>
              <a className="quickAction" href="/invoices"><span className="quickIcon">#</span><div><strong>Find an invoice</strong><span>Search status and recent activity</span></div><b>›</b></a>
              {portalConfig.features.batch && <a className="quickAction" href="/batch"><span className="quickIcon">≡</span><div><strong>Batch upload</strong><span>Submit multiple invoices at once</span></div><b>›</b></a>}
              {portalConfig.features.alerts && <a className="quickAction" href="/risk"><span className="quickIcon">!</span><div><strong>Review alerts</strong><span>See concentration and volume signals</span></div><b>›</b></a>}
            </div>
          </div>
        </section>

        <section className="portalPanel concentrationPanel">
          <div className="portalPanelHeader"><div><span className="panelKicker">Portfolio view</span><h2>Debtor concentration</h2><p>Share of invoice amount in the currently retrieved FactorCloud dataset.</p></div><a href="/risk">Open alerts</a></div>
          <div className="concentrationBars">
            {data.concentrations.slice(0, 5).map((row) => <div className="concentrationRow" key={row.debtorId}>
              <div className="concentrationLabel"><strong>{row.debtorName}</strong><span>{row.invoiceCount} invoice{row.invoiceCount === 1 ? '' : 's'} · {money(row.amount)}</span></div>
              <div className="concentrationTrack"><span style={{ width: `${Math.max(2, Math.min(100, row.share * 100))}%` }} /></div>
              <strong className="concentrationPct">{Math.round(row.share * 100)}%</strong>
            </div>)}
            {!data.concentrations.length && <div className="portalEmpty"><strong>No concentration data yet</strong><span>It will appear as invoice activity builds.</span></div>}
          </div>
        </section>

        <p className="portalDataNote">This first-client portal uses live records available from the FactorCloud integration environment. Concentration and volume alerts are v1 operational signals and can be configured per client as the product rolls out.</p>
      </>}
    </main>
  );
}

function Metric({ label, value, detail, tone = '' }: { label: string; value: string | number; detail: string; tone?: string }) {
  return <div className={`portalMetric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function shortName(name: string): string {
  return name.replace(/\b(LLC|INC|CORP|CORPORATION|LTD)\.?$/i, '').trim();
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusInitial(status: string | null): string {
  return (status || 'P').charAt(0).toUpperCase();
}

function statusTone(status: string | null): string {
  const value = (status || '').toUpperCase();
  if (value.includes('PAID') || value.includes('FUNDED') || value.includes('PURCHASE')) return 'pass';
  if (value.includes('REJECT') || value.includes('FAIL')) return 'fail';
  return 'review';
}
