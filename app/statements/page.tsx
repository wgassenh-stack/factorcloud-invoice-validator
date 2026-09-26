'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PortalNav } from '@/app/components/PortalNav';
import { DemoBadge } from '@/app/components/DemoBadge';
import { CountUp, Skeleton, VizEmpty, money } from '@/app/components/CommandCharts';
import { statementCsv, type Statement } from '@/lib/statements';

type StatementResponse = {
  statement: Statement;
  months: string[];
  client: { id: string; name: string };
  debtorNames: Record<string, string>;
  generatedAt: string;
  complete: boolean;
  error?: string;
};

export default function StatementsPage() {
  return <Suspense><StatementView /></Suspense>;
}

function StatementView() {
  const params = useSearchParams();
  const staffClient = params.get('client');
  const [month, setMonth] = useState(params.get('month') ?? '');
  const [data, setData] = useState<StatementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (which: string) => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams();
      if (which) query.set('month', which);
      if (staffClient) query.set('client', staffClient);
      const res = await fetch(`/api/statements?${query}`, { cache: 'no-store' });
      const body = await res.json() as StatementResponse;
      if (!res.ok) throw new Error(body.error || 'Could not load the statement.');
      setData(body);
      setMonth(body.statement.month);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [staffClient]);

  useEffect(() => { void load(month); }, []);

  function downloadCsv() {
    if (!data) return;
    const blob = new Blob([statementCsv(data.statement, data.debtorNames)], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `statement-${data.client.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${data.statement.month}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const s = data?.statement;
  return <main className="portalShell dashboardPage statementPage">
    {!staffClient && <PortalNav active="statements" />}
    {staffClient && <a className="portalBackLink noPrint" href={`/ops/clients/${encodeURIComponent(staffClient)}`}>← Back to client</a>}

    <section className="portalWelcome dashboardHero statementHero">
      <div>
        <div className="dashboardHeroMeta"><span className="eyebrow">Monthly statement</span><DemoBadge /></div>
        <h1>{s ? s.label : 'Statement'}</h1>
        <p>{data ? data.client.name : ' '}{data ? ` · generated ${new Date(data.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}</p>
      </div>
      <div className="portalWelcomeActions noPrint">
        <label className="statementMonth"><span>Month</span>
          <select value={month} onChange={(e) => { setMonth(e.target.value); void load(e.target.value); }} disabled={!data || loading}>
            {(data?.months ?? []).map((m) => <option key={m} value={m}>{new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${m}-01T00:00:00Z`))}</option>)}
          </select>
        </label>
        <button className="secondaryLink" onClick={downloadCsv} disabled={!data}>Download CSV</button>
        <button className="primaryLink" onClick={() => window.print()} disabled={!data}>Print / save PDF</button>
      </div>
    </section>

    {error && <div className="attentionSummary fail"><strong>Could not load the statement</strong><span>{error}</span></div>}
    {data && !data.complete && <div className="attentionSummary review"><strong>This statement may be incomplete</strong><span>Not every invoice could be read from FactorCloud.</span></div>}
    {loading && !data && <Skeleton height={140} lines={5} />}

    {s && <>
      <section className="statementSummary">
        <div className="statementTotal">
          <span>Paid to you this month</span>
          <strong><CountUp value={s.totalToClient} format={(v) => money(v, 2)} /></strong>
          <small>{money(s.funded.advanced, 2)} in advances + {money(s.paid.reserveReleased, 2)} reserve released</small>
        </div>
        <SummaryCell label="Invoices submitted" value={money(s.submitted.amount, 2)} detail={`${s.submitted.count} invoice${s.submitted.count === 1 ? '' : 's'}`} />
        <SummaryCell label="Funded" value={money(s.funded.amount, 2)} detail={`${s.funded.count} invoices · ${money(s.funded.advanced, 2)} advanced`} />
        <SummaryCell label="Paid by debtors" value={money(s.paid.amount, 2)} detail={`${s.paid.count} invoices`} />
        <SummaryCell label="Fees" value={money(s.paid.fees, 2)} detail="On invoices paid this month" />
        <SummaryCell label="Still open today" value={money(s.openToday.balance, 2)} detail={`${s.openToday.count} funded invoices awaiting payment`} />
      </section>

      <section className="dashCard statementLines">
        <div className="dashCardHeader"><div><span>Activity</span><h2>{s.lines.length} transaction{s.lines.length === 1 ? '' : 's'}</h2></div></div>
        {s.lines.length ? <div className="batchTableWrap">
          <table className="batchTable statementTable">
            <thead><tr><th>Date</th><th>Event</th><th>Invoice</th><th>Debtor</th><th className="num">Invoice amount</th><th className="num">To you</th><th className="num">Fee</th></tr></thead>
            <tbody>
              {s.lines.map((line) => <tr key={`${line.kind}-${line.invoiceId}`}>
                <td>{line.date}</td>
                <td><span className={`statementKind ${line.kind.toLowerCase()}`}>{line.kind === 'FUNDED' ? 'Funded' : 'Paid by debtor'}</span></td>
                <td>{staffClient ? line.invoiceNumber ?? line.invoiceId : <a href={`/invoices/${encodeURIComponent(line.invoiceId)}`}>{line.invoiceNumber ?? line.invoiceId}</a>}</td>
                <td>{line.debtorId ? data!.debtorNames[line.debtorId] ?? line.debtorId : '-'}</td>
                <td className="num">{money(line.invoiceAmount, 2)}</td>
                <td className="num"><strong>{money(line.toClient, 2)}</strong></td>
                <td className="num">{line.fee ? money(line.fee, 2) : '-'}</td>
              </tr>)}
            </tbody>
            <tfoot><tr><td colSpan={5}>Total</td><td className="num"><strong>{money(s.totalToClient, 2)}</strong></td><td className="num">{money(s.paid.fees, 2)}</td></tr></tfoot>
          </table>
        </div> : <VizEmpty title="No funding or payments this month" detail="Pick another month to see its activity." />}
      </section>
      <p className="portalDataNote">Built from FactorCloud invoice records. "To you" is the advance when an invoice is funded, and the reserve less fees when the debtor pays. FactorCloud remains the system of record.</p>
    </>}
  </main>;
}

function SummaryCell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="statementCell"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
