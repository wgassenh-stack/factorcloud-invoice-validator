'use client';

import { useEffect, useMemo, useState } from 'react';

type OpsClientSummary = {
  clientId: string;
  clientName: string;
  invoiceCount: number;
  invoiceAmount: number;
  latestInvoiceDate: string | null;
  statuses: Record<string, number>;
};

type OpsResponse = {
  clients: OpsClientSummary[];
  totals: { clientCount: number; invoiceCount: number; invoiceAmount: number };
  source: { returnedInvoiceCount: number; note: string };
  error?: string;
};

export default function FactorOperationsPage() {
  const [data, setData] = useState<OpsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/ops/clients', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load factor operations data.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return data?.clients ?? [];
    return (data?.clients ?? []).filter((client) => client.clientName.toLowerCase().includes(term) || client.clientId.toLowerCase().includes(term));
  }, [data, query]);

  return <main className="opsShell">
    <aside className="opsSidebar">
      <a className="opsBrand" href="/ops"><img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" /></a>
      <div className="opsRole">Factor Operations</div>
      <nav className="opsNav">
        <a className="active" href="/ops">Overview</a>
        <span>Clients</span>
        <span>Review queue</span>
        <span>Alerts</span>
        <span>Configuration</span>
      </nav>
      <div className="opsSidebarFooter"><strong>Internal view</strong><span>Factor-wide access</span></div>
    </aside>

    <section className="opsContent">
      <header className="opsHeader">
        <div><span className="eyebrow">Factor operations</span><h1>Client Overview</h1><p>Internal view across the factor's clients. Client portals remain isolated to a single client.</p></div>
        <button className="small opsRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
      </header>

      {error && <div className="attentionSummary fail"><strong>Could not load operations data</strong><span>{error}</span></div>}

      {data && <>
        <section className="opsMetrics">
          <Metric label="Clients in retrieved data" value={data.totals.clientCount} />
          <Metric label="Invoices" value={data.totals.invoiceCount} />
          <Metric label="Invoice amount" value={money(data.totals.invoiceAmount)} />
          <Metric label="Review queue" value="Next" detail="Will surface client REVIEW submissions here" />
        </section>

        <div className="warning opsDataNote">{data.source.note}</div>

        <section className="opsPanel">
          <div className="opsPanelHeader">
            <div><h2>Clients</h2><p>One row per client represented in the FactorCloud invoice data currently returned to the integration. Open a client to inspect its invoices, alerts, and concentration.</p></div>
            <label className="opsSearch"><span>Search</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Client name or ID" /></label>
          </div>

          <div className="batchTableWrap">
            <table className="batchTable opsTable">
              <thead><tr><th>Client</th><th>Invoices</th><th>Invoice amount</th><th>Latest activity</th><th>Status mix</th></tr></thead>
              <tbody>
                {filtered.map((client) => <tr key={client.clientId}>
                  <td><a className="opsClientLink" href={`/ops/clients/${encodeURIComponent(client.clientId)}`}><div className="opsClientName"><strong>{client.clientName}</strong><span>{client.clientId}</span></div></a></td>
                  <td>{client.invoiceCount}</td>
                  <td>{money(client.invoiceAmount)}</td>
                  <td>{client.latestInvoiceDate || '-'}</td>
                  <td><div className="opsStatuses">{Object.entries(client.statuses).slice(0, 4).map(([status, count]) => <span key={status}>{pretty(status)} <strong>{count}</strong></span>)}</div></td>
                </tr>)}
                {!filtered.length && <tr><td colSpan={5}>No matching clients found.</td></tr>}
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
