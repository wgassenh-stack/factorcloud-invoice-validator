'use client';

import { useEffect, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { Skeleton } from '@/app/components/CommandCharts';

type Rule = { id: string; label: string; status: 'PASS' | 'HOLD' | 'REVIEW' | 'SKIP' | 'UNKNOWN'; detail: string; cap?: boolean };
type Run = {
  id: string; factorCloudInvoiceId: string; factorCloudClientId: string; clientName: string | null; invoiceNumber: string | null;
  amount: number; mode: string; outcome: 'FUND' | 'HOLD' | 'REVIEW'; state: 'SUGGESTED' | 'REVIEW' | 'APPROVED' | 'FUNDING' | 'FUNDED' | 'FAILED';
  rules: Rule[]; reasons: string[]; detail: string | null; paymentType: string | null; autoFunded: boolean; fundedAt: string | null; createdAt: string;
};
type Data = { available: boolean; mode: 'off' | 'suggest' | 'approve' | 'fund'; runs: Run[]; canAct: boolean; note?: string };

const MODE: Record<Data['mode'], string> = {
  off: 'Off',
  suggest: 'Suggest only: people approve and fund',
  approve: 'Auto-approve: people fund',
  fund: 'Auto-fund within the caps',
};
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const today = (iso: string | null) => Boolean(iso && new Date(iso).toDateString() === new Date().toDateString());

export default function FundingPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ tone: 'pass' | 'fail'; text: string } | null>(null);

  async function load() {
    try {
      const res = await fetch('/api/ops/funding', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not load funding.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => { void load(); }, []);

  async function act(run: Run, action: 'approve' | 'fund') {
    if (action === 'fund' && !window.confirm(`Fund invoice ${run.invoiceNumber ?? ''} for ${money(run.amount)}${run.paymentType ? ` by ${run.paymentType}` : ''}? This sends money in FactorCloud.`)) return;
    setBusy(run.id);
    try {
      const res = await fetch(`/api/ops/funding/${encodeURIComponent(run.id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
      const body = await res.json();
      setToast({ tone: res.ok ? 'pass' : 'fail', text: res.ok ? `Invoice ${run.invoiceNumber ?? ''}: ${action === 'fund' ? 'Funded.' : body.detail || 'Approved for funding.'}` : body.detail || body.error || 'That did not work.' });
      setTimeout(() => setToast(null), 4000);
      await load();
    } finally {
      setBusy('');
    }
  }

  const runs = data?.runs ?? [];
  const waiting = runs.filter((r) => r.state === 'APPROVED' || r.state === 'FUNDING');
  const suggested = runs.filter((r) => r.state === 'SUGGESTED');
  const failed = runs.filter((r) => r.state === 'FAILED');
  const funded = runs.filter((r) => r.state === 'FUNDED');
  const review = runs.filter((r) => r.state === 'REVIEW');
  const autoToday = funded.filter((r) => r.autoFunded && today(r.fundedAt));

  return <main className="opsShell">
    <OpsSidebar active="funding" />
    <section className="opsContent">
      <header className="opsHeader">
        <div>
          <span className="eyebrow">Funding engine</span>
          <h1>Funding</h1>
          <p>What the factor's rules decided for each invoice sent through the portal, and what's waiting on a person.</p>
        </div>
        <div className="fundingHeaderActions">
          {data?.available && <span className={`fundingMode ${data.mode}`}>{MODE[data.mode]}</span>}
          <a className="secondaryLink" href="/ops/rules">Funding rules</a>
          <button className="small opsRefresh" onClick={() => void load()}>Refresh</button>
        </div>
      </header>

      {error && <div className="attentionSummary fail"><strong>Could not load funding</strong><span>{error}</span></div>}
      {!data && !error && <Skeleton height={140} lines={4} />}
      {data && !data.available && <div className="attentionSummary review"><strong>Funding engine unavailable</strong><span>{data.note}</span></div>}
      {data?.available && data.mode === 'off' && <div className="attentionSummary review"><strong>The funding engine is off</strong><span>Turn it on under Funding rules. Start with "Suggest only".</span></div>}

      {data?.available && <>
        <section className="opsMetrics fundingMetrics">
          <div className="opsMetric"><span>Needs a click</span><strong>{waiting.length}</strong><small>{money(waiting.reduce((s, r) => s + r.amount, 0))} approved, not funded</small></div>
          <div className="opsMetric"><span>Auto-funded today</span><strong>{autoToday.length}</strong><small>{money(autoToday.reduce((s, r) => s + r.amount, 0))}</small></div>
          <div className="opsMetric"><span>Suggestions</span><strong>{suggested.length}</strong><small>Waiting for a person to approve</small></div>
          <div className="opsMetric"><span>In review</span><strong>{review.length}</strong><small><a href="/ops/reviews">Review queue</a></small></div>
        </section>

        <FundingSection title="Needs a click" hint="Approved for funding in FactorCloud. A rule held back automatic funding, or the engine only approves." runs={waiting} empty="Nothing waiting to be funded."
          action={(run) => data.canAct && run.state === 'APPROVED' ? <button className="fundButton" disabled={Boolean(busy)} onClick={() => void act(run, 'fund')}>{busy === run.id ? 'Funding…' : `Fund ${money(run.amount)}`}</button> : run.state === 'FUNDING' ? <span className="muted">Funding…</span> : null} />
        {suggested.length > 0 && <FundingSection title="Suggestions" hint="Suggest-only mode: what the engine would do. Nothing has been done in FactorCloud." runs={suggested} empty=""
          action={(run) => data.canAct ? <button className="small" disabled={Boolean(busy)} onClick={() => void act(run, 'approve')}>{busy === run.id ? 'Approving…' : 'Approve for funding'}</button> : null} />}
        {failed.length > 0 && <FundingSection title="Couldn't be approved" hint="FactorCloud refused, or something was missing. The invoice is still pending in FactorCloud." runs={failed} empty=""
          action={(run) => data.canAct ? <button className="small" disabled={Boolean(busy)} onClick={() => void act(run, 'approve')}>{busy === run.id ? 'Approving…' : 'Try approving again'}</button> : null} />}
        <FundingSection title="Funded" hint="Funded by the engine, or by a person from this page." runs={funded} empty="Nothing funded through the portal yet." action={() => null} />
      </>}
      {toast && <div className={`reviewToast ${toast.tone}`} role="status"><b>{toast.tone === 'pass' ? '✓' : '✕'}</b>{toast.text}</div>}
    </section>
  </main>;
}

function FundingSection({ title, hint, runs, empty, action }: { title: string; hint: string; runs: Run[]; empty: string; action: (run: Run) => React.ReactNode }) {
  return <section className="fundingSection">
    <div className="opsPanelHeader"><div><h2>{title} <span className="fundingCount">{runs.length}</span></h2><p>{hint}</p></div></div>
    {runs.map((run) => <FundingCard key={run.id} run={run} action={action(run)} />)}
    {!runs.length && empty && <div className="portalEmpty"><strong>{empty}</strong></div>}
  </section>;
}

const OUTCOME: Record<Run['outcome'], string> = { FUND: 'Every rule passed', HOLD: 'Held for a person', REVIEW: 'Paperwork review' };
const ICON: Record<Rule['status'], string> = { PASS: '✓', HOLD: '!', REVIEW: '!', SKIP: '–', UNKNOWN: '?' };

function FundingCard({ run, action }: { run: Run; action: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const status = run.state === 'FUNDED' ? (run.autoFunded ? 'Auto-funded' : 'Funded') : run.state === 'APPROVED' ? 'Approved for funding' : run.state === 'SUGGESTED' ? (run.outcome === 'FUND' ? 'Would auto-fund' : 'Would hold') : run.state === 'FAILED' ? 'Not approved' : run.state === 'FUNDING' ? 'Funding' : 'In review';
  return <article className={`fundingCard ${run.state.toLowerCase()} ${run.outcome.toLowerCase()}`}>
    <div className="fundingCardMain">
      <div className="fundingCardTop">
        <strong>Invoice {run.invoiceNumber || run.factorCloudInvoiceId.slice(0, 8)}</strong>
        <span className={`fundingPill ${run.state.toLowerCase()}`}>{status}</span>
        <span className="muted">{run.clientName} · {when(run.fundedAt ?? run.createdAt)} · {OUTCOME[run.outcome]}</span>
      </div>
      {run.reasons.length > 0 && run.state !== 'FUNDED' && <ul className="fundingReasons">{run.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      {run.detail && <p className="fundingDetail">{run.detail}</p>}
      <button type="button" className="linkButton" onClick={() => setOpen(!open)}>{open ? 'Hide rules' : `Show all ${run.rules.length} rules`}</button>
      {open && <div className="fundingRules">{run.rules.map((rule) => <div key={rule.id} className={`fundingRule ${rule.status.toLowerCase()}`}>
        <b aria-hidden="true">{ICON[rule.status]}</b><div><strong>{rule.label}{rule.cap ? ' (auto-funding cap)' : ''}</strong><span>{rule.detail}</span></div>
      </div>)}</div>}
    </div>
    <div className="fundingCardSide">
      <strong className="fundingAmount">{money(run.amount)}</strong>
      {action}
    </div>
  </article>;
}
