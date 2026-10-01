'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { OpsEmpty, OpsHeader, OpsMetric, OpsNotice, OpsPanel, OpsStatus, opsFetch, opsMoney } from '@/app/components/OpsUI';
import { modeLabels, runLabel } from '@/lib/operations-view';
import type { EngineRun } from '@/lib/funding-engine';
import type { EngineMode } from '@/lib/rules/settings';

type InvoiceRecord = { id: string; invoiceNumber: string | null; companyDebtorId: string | null; invoiceAmount: number | null; invoiceDate: string | null; status: string | null };
type Policy = { mode: EngineMode; paused: boolean; custom: boolean; perInvoice: number; perClientPerDay: number; rulesOff: string[] } | null;
type ClientDetail = {
  client: { id: string; name: string; code: string | null; phone: string | null; city: string | null; state: string | null };
  records: InvoiceRecord[];
  debtorNames: Record<string, string>;
  summary: {
    totalAmount: number; invoiceCount: number; last7Amount: number; volumeRatio: number | null;
    concentrations: { debtorId: string; debtorName: string; amount: number; invoiceCount: number; share: number; level: 'NORMAL' | 'REVIEW' | 'HIGH' }[];
    alerts: { id: string; level: 'INFO' | 'REVIEW' | 'HIGH'; title: string; detail: string }[];
  };
  position: { openAr: number; openArCount: number; reserveHeld: number; pendingAmount: number; pendingCount: number; aging: number[] };
  creditLimit: number | null; creditLimitReadable: boolean; cashReserve: number | null;
  automation: Policy;
  work: { waiting: EngineRun[]; recent: EngineRun[] } | null;
  source: { note: string; complete?: boolean };
};

const AGING = ['0–30 days', '31–60 days', '61–90 days', '90+ days'];

/** Where a decision is handled: the Funding Center lane, or Paperwork Review. */
function workHref(run: EngineRun): string {
  if (run.state === 'REVIEW') return '/ops/reviews';
  const lane = run.state === 'SUGGESTED' && run.mode !== 'fund' ? 'suggestions' : run.state === 'FAILED' || run.state === 'FUNDING' ? 'exceptions' : 'decision';
  return `/ops/funding?lane=${lane}&run=${encodeURIComponent(run.id)}`;
}

export default function FactorClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const [data, setData] = useState<ClientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true); setError('');
    try { setData(await opsFetch<ClientDetail>(`/api/ops/clients/${encodeURIComponent(clientId)}`)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [clientId]);

  // Funded invoices from FactorCloud, for when the portal has no funding decisions of its own yet
  // (funded before the portal, or directly in FactorCloud).
  const fundedInFc = useMemo(() => (data?.records ?? []).filter((r) => /^(FUNDED|PAID)/i.test(r.status ?? '')).sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? ''))).slice(0, 5), [data]);
  const recent = useMemo(() => (data?.records ?? []).slice().sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? ''))).slice(0, 12), [data]);
  const waiting = data?.work?.waiting ?? [];
  const waitingAmount = waiting.reduce((t, r) => t + r.amount, 0);
  const p = data?.position;
  const place = data ? [data.client.code, [data.client.city, data.client.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') : '';

  return <main className="opsShell"><OpsSidebar active="reports" /><section className="opsContent">
    <OpsHeader title={data?.client.name || 'Client'} description={data ? place || 'FactorCloud client' : 'Loading the client from FactorCloud…'}
      actions={<><a className="oc-button" href="/ops/reports?tab=clients">All clients</a><a className="oc-button" href={`/statements?client=${encodeURIComponent(clientId)}`}>Statement</a><button className="oc-button" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button></>}>
      {data?.automation && <OpsStatus tone={data.automation.paused || data.automation.mode === 'off' ? 'neutral' : data.automation.mode === 'fund' ? 'good' : 'info'}>{data.automation.paused ? 'Automation paused' : modeLabels[data.automation.mode]}</OpsStatus>}
    </OpsHeader>
    {error && <OpsNotice tone="bad">{error}</OpsNotice>}
    {!data ? <OpsEmpty>{loading ? 'Loading client…' : 'Client data unavailable.'}</OpsEmpty> : <>
      {data.source.complete === false && <OpsNotice tone="warn">{data.source.note}</OpsNotice>}
      <div className="oc-metrics five">
        <OpsMetric label="Funded, not yet paid" value={opsMoney(p!.openAr)} detail={`${p!.openArCount} invoice${p!.openArCount === 1 ? '' : 's'} out with debtors`} />
        <OpsMetric label="Reserve held" value={opsMoney(p!.reserveHeld)} detail="Returned to the client as debtors pay" />
        <OpsMetric label="Sent, not yet funded" value={opsMoney(p!.pendingAmount)} detail={`${p!.pendingCount} invoice${p!.pendingCount === 1 ? '' : 's'} in FactorCloud`} />
        <OpsMetric label="Needs a person" value={waiting.length} detail={waiting.length ? opsMoney(waitingAmount) + ' waiting' : 'Nothing waiting'} critical={waiting.length > 0} href={waiting.length ? '#waiting' : undefined} />
        <OpsMetric label="Client credit limit" value={data.creditLimit ? `${Math.round((p!.openAr / data.creditLimit) * 100)}% used` : data.creditLimitReadable ? 'None set' : '—'} detail={data.creditLimit ? `${opsMoney(p!.openAr)} of ${opsMoney(data.creditLimit)}` : data.creditLimitReadable ? 'No client-level limit in FactorCloud' : 'Not available here'} />
      </div>

      <div className="oc-grid"><div className="oc-stack">
        <div id="waiting" />
        <OpsPanel title="Waiting on you" description="This client's invoices that the automation held, or that need paperwork review.">
          {!data.work ? <OpsEmpty>Funding decisions need database sign-in.</OpsEmpty> : !waiting.length ? <OpsEmpty>Nothing is waiting on the factor for this client.</OpsEmpty> :
            <div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>Invoice</th><th>Status & reason</th><th className="num">Invoice value</th><th /></tr></thead><tbody>
              {waiting.map((run) => <tr key={run.id}><td className="oc-identity"><strong>{run.invoiceNumber || run.factorCloudInvoiceId.slice(0, 8)}</strong><small>{run.debtorName || '—'}</small></td>
                <td><OpsStatus tone={run.state === 'FAILED' || run.state === 'FUNDING' ? 'bad' : run.state === 'REVIEW' ? 'warn' : 'info'}>{run.state === 'REVIEW' ? 'Paperwork review' : runLabel(run)}</OpsStatus><div className="oc-reason">{run.reasons[0] || run.detail || ''}</div></td>
                <td className="num"><strong>{opsMoney(run.amount)}</strong></td><td><a className="oc-button" href={workHref(run)}>Open</a></td></tr>)}
            </tbody></table></div>}
        </OpsPanel>

        <OpsPanel title="Funded money still out" description="Unpaid balance of funded invoices, by age from invoice date.">
          <div className="oc-body">
            {p!.openAr > 0 ? AGING.map((label, i) => <div className="oc-figure-row" key={label}><span>{label}</span><div className="oc-bar"><i style={{ width: `${(p!.aging[i] / p!.openAr) * 100}%`, background: i >= 3 ? '#a73544' : i === 2 ? '#c98a1b' : undefined }} /></div><strong className="oc-num">{opsMoney(p!.aging[i])}</strong></div>)
              : <OpsEmpty>No funded invoices are waiting on debtors.</OpsEmpty>}
            {p!.aging[3] > 0 && <p className="oc-note">{opsMoney(p!.aging[3])} is over 90 days old.</p>}
          </div>
        </OpsPanel>

        <OpsPanel title="Debtors" description="Who this client's invoices are with, and warning signs.">
          <div className="oc-body">
            {data.summary.alerts.map((a) => <OpsNotice key={a.id} tone={a.level === 'HIGH' ? 'bad' : a.level === 'REVIEW' ? 'warn' : 'info'}><strong>{a.title}.</strong> {a.detail}</OpsNotice>)}
            {data.summary.concentrations.slice(0, 6).map((row) => <div className="oc-figure-row wide" key={row.debtorId}><span><a className="oc-link" href={`/ops/debtors?debtor=${encodeURIComponent(row.debtorId)}`}>{row.debtorName}</a></span><div className="oc-bar"><i style={{ width: `${row.share * 100}%` }} /></div><strong className="oc-num">{Math.round(row.share * 100)}%</strong></div>)}
            {!data.summary.concentrations.length && <OpsEmpty>No debtor activity yet.</OpsEmpty>}
          </div>
        </OpsPanel>
      </div>

      <aside className="oc-stack">
        <OpsPanel title="Automation for this client">
          {!data.automation ? <OpsEmpty>Automation rules need database sign-in.</OpsEmpty> : <div className="oc-body">
            <h3>{data.automation.paused ? 'Paused for all clients' : modeLabels[data.automation.mode]}</h3>
            <p className="oc-small oc-muted">{data.automation.custom ? 'This client has its own rules.' : 'Uses the factor defaults.'}</p>
            <dl className="oc-facts">
              <div><dt>Automatic funding up to</dt><dd>{opsMoney(data.automation.perInvoice)} each</dd></div>
              <div><dt>Daily limit</dt><dd>{opsMoney(data.automation.perClientPerDay)}</dd></div>
              <div><dt>Rules switched off</dt><dd>{data.automation.rulesOff.length ? data.automation.rulesOff.join(', ') : 'None'}</dd></div>
              {data.cashReserve != null && <div><dt>Cash reserve</dt><dd style={data.cashReserve < 0 ? { color: '#a73544' } : undefined}>{opsMoney(data.cashReserve)}</dd></div>}
            </dl>
            <p><a className="oc-link" href={`/ops/rules?tab=clients&client=${encodeURIComponent(clientId)}`}>{data.automation.custom ? 'Change this client\'s rules →' : 'Give this client its own rules →'}</a></p>
          </div>}
        </OpsPanel>
        <OpsPanel title="Recently funded">
          {data.work?.recent.length ? data.work.recent.map((run) => <div className="oc-activity plain" key={run.id}><div><strong>{run.invoiceNumber || run.factorCloudInvoiceId.slice(0, 8)}</strong><small>{run.autoFunded ? 'Funded automatically' : 'Funded by a person'}{run.debtorName ? ' · ' + run.debtorName : ''}</small></div><strong className="oc-num">{opsMoney(run.amount)}</strong></div>) : fundedInFc.length ? fundedInFc.map((r) => <div className="oc-activity plain" key={r.id}><div><strong>{r.invoiceNumber || r.id.slice(0, 8)}</strong><small>{r.companyDebtorId && data.debtorNames[r.companyDebtorId] ? data.debtorNames[r.companyDebtorId] : 'Funded in FactorCloud'}{r.invoiceDate ? ' · ' + r.invoiceDate.slice(5, 10) : ''}</small></div><strong className="oc-num">{r.invoiceAmount == null ? '—' : opsMoney(r.invoiceAmount)}</strong></div>) : <OpsEmpty>Nothing funded yet.</OpsEmpty>}
        </OpsPanel>
        <OpsPanel title="Volume">
          <div className="oc-body"><dl className="oc-facts">
            <div><dt>Last 7 days</dt><dd>{opsMoney(data.summary.last7Amount)}</dd></div>
            <div><dt>Pace vs. usual</dt><dd>{data.summary.volumeRatio == null ? 'Not enough history' : `${data.summary.volumeRatio.toFixed(1)}×`}</dd></div>
            <div><dt>All invoices loaded</dt><dd>{data.summary.invoiceCount.toLocaleString()} · {opsMoney(data.summary.totalAmount)}</dd></div>
          </dl></div>
        </OpsPanel>
      </aside></div>

      <OpsPanel title="Recent invoices" description="Latest invoices for this client in FactorCloud.">
        <div className="oc-table-wrap"><table className="oc-table"><thead><tr><th>Invoice</th><th>Debtor</th><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead><tbody>
          {recent.map((r) => <tr key={r.id}><td><strong>{r.invoiceNumber || r.id.slice(0, 8)}</strong></td><td>{r.companyDebtorId ? data.debtorNames[r.companyDebtorId] || r.companyDebtorId : '—'}</td><td>{r.invoiceDate?.slice(0, 10) || '—'}</td><td className="num">{r.invoiceAmount == null ? '—' : opsMoney(r.invoiceAmount)}</td><td>{pretty(r.status || 'Unknown')}</td></tr>)}
          {!recent.length && <tr><td colSpan={5}>No invoices found for this client.</td></tr>}
        </tbody></table></div>
      </OpsPanel>
    </>}
  </section></main>;
}

function pretty(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
