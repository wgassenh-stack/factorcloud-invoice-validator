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
};

type PortalWorkflowSummary = {
  workflowStatus: string;
  validationStatus: string;
  updatedAt: string;
};

type InvoiceData = {
  records: RiskRecord[];
  concentrations: Concentration[];
  portalWorkflows?: Record<string, PortalWorkflowSummary>;
  source: { clientName: string; clientInvoiceCount: number };
};

export default function InvoicesPage() {
  const [data, setData] = useState<InvoiceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invoice = params.get('invoice');
    if (invoice) setQuery(invoice);
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/risk', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load invoices.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const debtorNames = useMemo(() => Object.fromEntries((data?.concentrations ?? []).map((row) => [row.debtorId, row.debtorName])), [data]);
  const statuses = useMemo(() => [...new Set((data?.records ?? []).map((record) => record.status || 'UNKNOWN'))].sort(), [data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.records ?? [])
      .filter((record) => statusFilter === 'ALL' || (record.status || 'UNKNOWN') === statusFilter)
      .filter((record) => {
        if (!needle) return true;
        const debtor = record.companyDebtorId ? debtorNames[record.companyDebtorId] || record.companyDebtorId : '';
        const portal = data?.portalWorkflows?.[record.id];
        return [record.invoiceNumber, debtor, record.id, record.status, portal?.workflowStatus]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      })
      .sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? '')));
  }, [data, debtorNames, query, statusFilter]);

  const total = filtered.reduce((sum, record) => sum + (record.invoiceAmount ?? 0), 0);

  return <main className="portalShell">
    <PortalNav active="invoices" />

    <section className="portalWelcome portalPageIntro">
      <div>
        <span className="eyebrow">FactorCloud Client Portal</span>
        <h1>Invoices</h1>
        <p>Search your invoice activity and see both FactorCloud status and portal review status in one place.</p>
      </div>
      <div className="portalWelcomeActions">
        <a className="primaryLink" href="/submit">+ Submit invoice</a>
      </div>
    </section>

    {error && <div className="attentionSummary fail"><strong>Could not load invoices</strong><span>{error}</span></div>}

    <section className="invoiceToolbar">
      <label className="invoiceSearch"><span>Search</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Invoice number or debtor" /></label>
      <label className="invoiceFilter"><span>FactorCloud status</span><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="ALL">All statuses</option>{statuses.map((status) => <option key={status} value={status}>{prettyStatus(status)}</option>)}</select></label>
      <div className="invoiceToolbarSummary"><strong>{filtered.length}</strong><span>invoices</span><strong>{money(total)}</strong><span>shown</span></div>
    </section>

    <section className="portalPanel invoiceTablePanel">
      <div className="portalPanelHeader"><div><span className="panelKicker">Invoice history</span><h2>{data?.source.clientName || 'Client invoices'}</h2></div><button className="small invoiceRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button></div>
      <div className="batchTableWrap">
        <table className="batchTable portalInvoiceTable">
          <thead><tr><th>Invoice</th><th>Debtor</th><th>Invoice date</th><th>Amount</th><th>FactorCloud</th><th>Portal review</th></tr></thead>
          <tbody>
            {filtered.map((record) => {
              const portal = data?.portalWorkflows?.[record.id];
              return <tr key={record.id}>
                <td><a className="invoiceDetailLink" href={`/invoices/${encodeURIComponent(record.id)}`}><div className="invoiceTableIdentity"><strong>{record.invoiceNumber || record.id.slice(0, 8)}</strong><span>{record.id.slice(0, 8)}</span></div></a></td>
                <td>{record.companyDebtorId ? debtorNames[record.companyDebtorId] || 'FactorCloud debtor' : '-'}</td>
                <td>{record.invoiceDate || '-'}</td>
                <td><strong>{record.invoiceAmount == null ? '-' : money(record.invoiceAmount)}</strong></td>
                <td><span className={`portalStatus ${statusTone(record.status)}`}>{prettyStatus(record.status || 'Unknown')}</span></td>
                <td>{portal ? <span className={`portalStatus ${statusTone(portal.workflowStatus)}`}>{prettyStatus(portal.workflowStatus)}</span> : <span className="portalMuted">-</span>}</td>
              </tr>;
            })}
            {!loading && !filtered.length && <tr><td colSpan={6}><div className="portalEmpty"><strong>No invoices match your filters</strong><span>Try a different invoice number, debtor, or status.</span></div></td></tr>}
            {loading && !data && <tr><td colSpan={6}><div className="portalEmpty"><strong>Loading invoices...</strong><span>Reading current activity from FactorCloud.</span></div></td></tr>}
          </tbody>
        </table>
      </div>
    </section>

    <p className="portalDataNote">FactorCloud status is the accounting/factoring state. Portal review is the client-submission workflow state. Open an invoice for documents, validation checks, review history, and the audit trail.</p>
  </main>;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function prettyStatus(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(status: string | null): string {
  const value = (status || '').toUpperCase();
  if (value.includes('PASS') || value.includes('APPROV') || value.includes('PAID') || value.includes('FUNDED') || value.includes('PURCHASE') || value.includes('CREATED')) return 'pass';
  if (value.includes('REJECT') || value.includes('FAIL') || value.includes('ERROR')) return 'fail';
  return 'review';
}
