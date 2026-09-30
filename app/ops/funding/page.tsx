'use client';

import { useEffect, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { Skeleton } from '@/app/components/CommandCharts';
import styles from './FundingPage.module.css';

type Rule = { id: string; label: string; status: 'PASS' | 'HOLD' | 'REVIEW' | 'SKIP' | 'UNKNOWN'; detail: string; cap?: boolean };
type Run = {
  id: string;
  factorCloudInvoiceId: string;
  factorCloudClientId: string;
  clientName: string | null;
  invoiceNumber: string | null;
  amount: number;
  mode: string;
  outcome: 'FUND' | 'HOLD' | 'REVIEW';
  state: 'SUGGESTED' | 'REVIEW' | 'APPROVED' | 'FUNDING' | 'FUNDED' | 'FAILED';
  rules: Rule[];
  reasons: string[];
  detail: string | null;
  paymentType: string | null;
  autoFunded: boolean;
  fundedAt: string | null;
  createdAt: string;
};
type Data = { available: boolean; mode: 'off' | 'suggest' | 'approve' | 'fund'; runs: Run[]; canAct: boolean; note?: string };

const MODE: Record<Data['mode'], string> = {
  off: 'Automation off',
  suggest: 'Suggest only',
  approve: 'Auto-approve',
  fund: 'Auto-fund active',
};

export default function FundingPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState<{ tone: 'pass' | 'fail'; text: string } | null>(null);

  async function load() {
    setError('');
    try {
      const response = await fetch('/api/ops/funding', { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load funding.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { void load(); }, []);

  async function act(run: Run, action: 'approve' | 'fund') {
    if (action === 'fund' && !window.confirm(`Fund invoice ${run.invoiceNumber ?? ''} for ${money(run.amount)}${run.paymentType ? ` by ${run.paymentType}` : ''}? This sends money in FactorCloud.`)) return;
    setBusy(run.id);
    setError('');
    try {
      const response = await fetch(`/api/ops/funding/${encodeURIComponent(run.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await response.json();
      const text = response.ok
        ? `Invoice ${run.invoiceNumber ?? ''}: ${action === 'fund' ? 'Funded.' : body.detail || 'Approved for funding.'}`
        : body.detail || body.error || 'That did not work.';
      setToast({ tone: response.ok ? 'pass' : 'fail', text });
      setTimeout(() => setToast(null), 4000);
      await load();
    } catch (err) {
      setToast({ tone: 'fail', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy('');
    }
  }

  const runs = data?.runs ?? [];
  const waiting = runs.filter((run) => run.state === 'APPROVED' || run.state === 'FUNDING');
  const suggested = runs.filter((run) => run.state === 'SUGGESTED');
  const failed = runs.filter((run) => run.state === 'FAILED');
  const funded = runs.filter((run) => run.state === 'FUNDED');
  const review = runs.filter((run) => run.state === 'REVIEW');
  const autoToday = funded.filter((run) => run.autoFunded && isToday(run.fundedAt));

  return <main className={`opsShell ${styles.page}`}>
    <OpsSidebar active="funding" />
    <section className="opsContent">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.headerMeta}><span className="eyebrow">Automation center</span>{data?.available && <span className={styles.mode} data-mode={data.mode}>{MODE[data.mode]}</span>}</div>
          <h1>Funding decisions</h1>
          <p>Invoices arrive here after paperwork clears. The engine can suggest, approve, or fund within the factor's rules. Anything it cannot safely complete stays visible for a person.</p>
        </div>
        <div className={styles.actions}>
          <a className="secondaryLink" href="/ops">Automation center</a>
          <a className="secondaryLink" href="/ops/rules">Rules & automation</a>
          <button className="small opsRefresh" onClick={() => void load()}>Refresh</button>
        </div>
      </header>

      {error && <div className="attentionSummary fail"><strong>Could not load funding</strong><span>{error}</span></div>}
      {!data && !error && <Skeleton height={150} lines={4} />}
      {data && !data.available && <div className={styles.notice}><strong>Funding automation unavailable.</strong> {data.note}</div>}
      {data?.available && data.mode === 'off' && <div className={styles.notice}><strong>The funding engine is off.</strong> Turn it on under Rules & automation. Starting in Suggest only mode is the safest way to validate the rules.</div>}

      {data?.available && <>
        <section className={styles.metrics}>
          <Metric label="Needs a click" value={waiting.length} detail={`${money(waiting.reduce((sum, run) => sum + run.amount, 0))} approved, not completed`} tone={waiting.length ? 'warn' : undefined} />
          <Metric label="Suggestions" value={suggested.length} detail="Waiting for a person to approve" />
          <Metric label="Auto-funded today" value={autoToday.length} detail={`${money(autoToday.reduce((sum, run) => sum + run.amount, 0))} funded automatically`} />
          <Metric label="In paperwork review" value={review.length} detail="Handled in the review queue" tone={review.length ? 'warn' : undefined} />
        </section>

        <FundingSection
          kicker="Action required"
          title="Needs a click"
          hint="These invoices are approved for funding, but automatic funding stopped or the factor's current mode still requires a person."
          runs={waiting}
          empty="Nothing is waiting for a funding click."
          action={(run) => data.canAct && run.state === 'APPROVED'
            ? <button className={styles.fund} disabled={Boolean(busy)} onClick={() => void act(run, 'fund')}>{busy === run.id ? 'Funding…' : `Fund ${money(run.amount)}`}</button>
            : run.state === 'FUNDING'
              ? <a className={styles.recovery} href="/ops/recovery">Check recovery</a>
              : null}
        />

        {suggested.length > 0 && <FundingSection
          kicker="Human approval"
          title="Suggestions"
          hint="The engine has evaluated these invoices, but Suggest only mode means nothing has been approved in FactorCloud yet."
          runs={suggested}
          empty=""
          action={(run) => data.canAct ? <button className={styles.approve} disabled={Boolean(busy)} onClick={() => void act(run, 'approve')}>{busy === run.id ? 'Checking…' : 'Approve for funding'}</button> : null}
        />}

        {failed.length > 0 && <FundingSection
          kicker="Could not complete"
          title="Approval failures"
          hint="The last approval attempt failed. Trying again re-checks the live rules and current FactorCloud data before anything moves."
          runs={failed}
          empty=""
          action={(run) => data.canAct ? <button className={styles.approve} disabled={Boolean(busy)} onClick={() => void act(run, 'approve')}>{busy === run.id ? 'Checking…' : 'Try approving again'}</button> : null}
        />}

        <FundingSection
          kicker="Completed"
          title="Funding history"
          hint="Invoices funded by the engine or by a person from this page."
          runs={funded}
          empty="Nothing has been funded through the portal yet."
          action={() => null}
        />
      </>}

      {toast && <div className={styles.toast} data-tone={toast.tone} role="status">{toast.text}</div>}
    </section>
  </main>;
}

function Metric({ label, value, detail, tone }: { label: string; value: number; detail: string; tone?: 'warn' | 'danger' }) {
  return <div className={styles.metric} data-tone={tone}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function FundingSection({ kicker, title, hint, runs, empty, action }: { kicker: string; title: string; hint: string; runs: Run[]; empty: string; action: (run: Run) => React.ReactNode }) {
  return <section className={styles.section}>
    <div className={styles.sectionHeader}>
      <div className={styles.sectionTitle}><span>{kicker}</span><h2>{title}</h2><p>{hint}</p></div>
      <span className={styles.count}>{runs.length}</span>
    </div>
    <div className={styles.rows}>
      {runs.map((run) => <FundingRow key={run.id} run={run} action={action(run)} />)}
      {!runs.length && empty && <div className={styles.empty}>{empty}</div>}
    </div>
  </section>;
}

function FundingRow({ run, action }: { run: Run; action: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <article className={styles.row}>
    <div className={styles.rowMain}>
      <div className={styles.rowTop}>
        <strong>Invoice {run.invoiceNumber || run.factorCloudInvoiceId.slice(0, 8)}</strong>
        <span className={styles.pill} data-state={run.state}>{statusLabel(run)}</span>
        <span className={styles.meta}>{run.clientName ?? 'Client'} · {when(run.fundedAt ?? run.createdAt)}</span>
      </div>
      {run.reasons.length > 0 && run.state !== 'FUNDED' && <ul className={styles.reasons}>{run.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
      {run.detail && <p className={styles.detail}>{run.detail}</p>}
      <button type="button" className={styles.rulesButton} onClick={() => setOpen((value) => !value)}>{open ? 'Hide rule detail' : `Show ${run.rules.length} rule results`}</button>
      {open && <div className={styles.rules}>{run.rules.map((rule) => <div className={styles.rule} data-status={rule.status} key={rule.id}>
        <b aria-hidden="true">{ruleIcon(rule.status)}</b>
        <div><strong>{rule.label}{rule.cap ? ' · auto-funding cap' : ''}</strong><span>{rule.detail}</span></div>
      </div>)}</div>}
    </div>
    <div className={styles.rowSide}><strong className={styles.amount}>{money(run.amount)}</strong>{action}</div>
  </article>;
}

function statusLabel(run: Run): string {
  if (run.state === 'FUNDED') return run.autoFunded ? 'Auto-funded' : 'Funded';
  if (run.state === 'APPROVED') return 'Approved for funding';
  if (run.state === 'SUGGESTED') return run.outcome === 'FUND' ? 'Would auto-fund' : run.outcome === 'HOLD' ? 'Would hold' : 'Would review';
  if (run.state === 'FAILED') return 'Not approved';
  if (run.state === 'FUNDING') return 'Funding uncertain';
  return 'In review';
}

function ruleIcon(status: Rule['status']): string {
  if (status === 'PASS') return '✓';
  if (status === 'HOLD' || status === 'REVIEW') return '!';
  if (status === 'SKIP') return '–';
  return '?';
}

function money(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function when(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : value;
}

function isToday(value: string | null): boolean {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toDateString() === new Date().toDateString();
}
