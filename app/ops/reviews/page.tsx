'use client';

import { useEffect, useMemo, useState } from 'react';

type ReviewRecord = {
  id: string;
  invoiceNumber: string | null;
  companyClientId: string | null;
  companyDebtorId: string | null;
  invoiceAmount: number | null;
  invoiceDate: string | null;
  status: string | null;
  notes?: string | null;
};

type ReviewResponse = {
  records: ReviewRecord[];
  clientNames: Record<string, string>;
  debtorNames: Record<string, string>;
  source: { note: string };
  error?: string;
};

export default function ReviewQueuePage() {
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/ops/reviews', { cache: 'no-store' });
      const body = await res.json() as ReviewResponse;
      if (!res.ok) throw new Error(body.error || 'Could not load review queue.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data?.records ?? [];
    return (data?.records ?? []).filter((record) => {
      const client = record.companyClientId ? data?.clientNames[record.companyClientId] || record.companyClientId : '';
      const debtor = record.companyDebtorId ? data?.debtorNames[record.companyDebtorId] || record.companyDebtorId : '';
      return [record.invoiceNumber, client, debtor, record.status].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [data, query]);

  return <main className="opsShell">
    <aside className="opsSidebar">
      <a className="opsBrand" href="/ops"><img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" /></a>
      <div className="opsRole">Factor Operations</div>
      <nav className="opsNav">
        <a href="/ops">Overview</a>
        <a href="/ops">Clients</a>
        <a className="active" href="/ops/reviews">Review queue</a>
        <span>Alerts</span>
        <span>Configuration</span>
      </nav>
      <div className="opsSidebarFooter"><strong>Internal view</strong><span>Factor-wide access</span></div>
    </aside>

    <section className="opsContent">
      <header className="opsHeader">
        <div><span className="eyebrow">Factor operations</span><h1>Review Queue</h1><p>Client submissions that reached FactorCloud with a portal review marker.</p></div>
        <button className="small opsRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
      </header>

      {error && <div className="attentionSummary fail"><strong>Could not load review queue</strong><span>{error}</span></div>}

      {data && <>
        <section className="opsMetrics opsReviewMetrics">
          <Metric label="Needs review" value={data.records.length} />
          <Metric label="Invoice amount" value={money(data.records.reduce((sum, record) => sum + (record.invoiceAmount ?? 0), 0))} />
          <Metric label="Clients affected" value={new Set(data.records.map((record) => record.companyClientId).filter(Boolean)).size} />
          <Metric label="Workflow" value="V1" detail="Database-backed decisions and audit history are next" />
        </section>

        <div className="warning opsDataNote">{data.source.note}</div>

        <section className="opsPanel">
          <div className="opsPanelHeader">
            <div><h2>Items requiring factor review</h2><p>These submissions were not presented as clean PASS invoices to the factor.</p></div>
            <label className="opsSearch"><span>Search</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Invoice, client, or debtor" /></label>
          </div>

          <div className="batchTableWrap">
            <table className="batchTable opsTable">
              <thead><tr><th>Invoice</th><th>Client</th><th>Debtor</th><th>Date</th><th>Amount</th><th>FactorCloud status</th></tr></thead>
              <tbody>
                {filtered.map((record) => <tr key={record.id}>
                  <td><strong>{record.invoiceNumber || record.id.slice(0, 8)}</strong></td>
                  <td>{record.companyClientId ? <a className="opsInlineLink" href={`/ops/clients/${encodeURIComponent(record.companyClientId)}`}>{data.clientNames[record.companyClientId] || record.companyClientId}</a> : '-'}</td>
                  <td>{record.companyDebtorId ? data.debtorNames[record.companyDebtorId] || record.companyDebtorId : '-'}</td>
                  <td>{record.invoiceDate || '-'}</td>
                  <td>{record.invoiceAmount == null ? '-' : money(record.invoiceAmount)}</td>
                  <td>{pretty(record.status || 'Unknown')}</td>
                </tr>)}
                {!loading && !filtered.length && <tr><td colSpan={6}>No portal review items were found in the retrieved FactorCloud invoice data.</td></tr>}
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
