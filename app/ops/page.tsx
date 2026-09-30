'use client';

import { useEffect, useMemo, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { DashboardSkeleton } from '@/app/components/CommandCharts';
import { DemoBadge } from '@/app/components/DemoBadge';
import styles from './AutomationCenter.module.css';

type ClientSummary = {
  clientId: string;
  clientName: string;
  invoiceCount: number;
  invoiceAmount: number;
  latestInvoiceDate: string | null;
};

type OpsData = {
  clients: ClientSummary[];
  totals: { clientCount: number; invoiceCount: number; invoiceAmount: number };
  portfolio: {
    topClientShare: number;
    arrivedToday: { available: boolean; count: number; amount: number };
  };
  analytics: {
    kpis: {
      openBalance: number;
      openCount: number;
      fundedLast30: number;
      collectedLast30: number;
      feesLast30: number;
      dsoLast90: number | null;
    };
    aging: { totals: number[]; openBalance: number; openCount: number };
  };
  demo?: boolean;
  source: { complete?: boolean; note: string };
};

type FundingRun = {
  id: string;
  factorCloudInvoiceId: string;
  clientName: string | null;
  invoiceNumber: string | null;
  amount: number;
  outcome: 'FUND' | 'HOLD' | 'REVIEW';
  state: 'SUGGESTED' | 'REVIEW' | 'APPROVED' | 'FUNDING' | 'FUNDED' | 'FAILED';
  reasons: string[];
  detail: string | null;
  autoFunded: boolean;
  fundedAt: string | null;
  createdAt: string;
};

type FundingData = {
  available: boolean;
  mode: 'off' | 'suggest' | 'approve' | 'fund';
  runs: FundingRun[];
  canAct: boolean;
  note?: string;
};

type ReviewRecord = {
  id: string;
  reviewId?: string;
  submissionId?: string;
  invoiceNumber: string | null;
  companyClientId: string | null;
  companyDebtorId: string | null;
  invoiceAmount: number | null;
  reason?: string;
  createdAt?: string;
};

type ReviewData = {
  records: ReviewRecord[];
  clientNames: Record<string, string>;
  debtorNames: Record<string, string>;
};

type RecoveryItem = {
  id: string;
  kind: string;
  detail: string;
  created_at: string;
  submission_id: string | null;
  invoice_number: string | null;
  factorcloud_invoice_id: string | null;
};

type RecoveryData = { items: RecoveryItem[]; editable: boolean; note?: string };

type WorkItem = {
  key: string;
  kind: 'review' | 'funding' | 'recovery';
  title: string;
  meta: string;
  amount: number | null;
  status: string;
  href: string;
  createdAt: string;
  priority: number;
};

const MODE_LABEL: Record<FundingData['mode'], string> = {
  off: 'Automation off',
  suggest: 'Suggest only',
  approve: 'Auto-approve',
  fund: 'Auto-fund active',
};

export default function AutomationCenterPage() {
  const [ops, setOps] = useState<OpsData | null>(null);
  const [funding, setFunding] = useState<FundingData | null>(null);
  const [reviews, setReviews] = useState<ReviewData | null>(null);
  const [recovery, setRecovery] = useState<RecoveryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [query, setQuery] = useState('');

  async function load() {
    setLoading(true);
    setWarnings([]);
    const requests = [
      fetchJson<OpsData>('/api/ops/clients'),
      fetchJson<FundingData>('/api/ops/funding'),
      fetchJson<ReviewData>('/api/ops/reviews'),
      fetchJson<RecoveryData>('/api/ops/recovery'),
    ] as const;
    const results = await Promise.allSettled(requests);
    const failures: string[] = [];

    if (results[0].status === 'fulfilled') setOps(results[0].value);
    else failures.push(`Portfolio: ${message(results[0].reason)}`);
    if (results[1].status === 'fulfilled') setFunding(results[1].value);
    else failures.push(`Funding: ${message(results[1].reason)}`);
    if (results[2].status === 'fulfilled') setReviews(results[2].value);
    else failures.push(`Reviews: ${message(results[2].reason)}`);
    if (results[3].status === 'fulfilled') setRecovery(results[3].value);
    else failures.push(`Recovery: ${message(results[3].reason)}`);

    setWarnings(failures);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  const runs = funding?.runs ?? [];
  const reviewCount = reviews?.records.length ?? 0;
  const readyToFund = runs.filter((run) => run.state === 'APPROVED');
  const autoFundedToday = runs.filter((run) => run.state === 'FUNDED' && run.autoFunded && isToday(run.fundedAt));
  const recoveryCount = recovery?.items.length ?? 0;

  const work = useMemo<WorkItem[]>(() => {
    const items: WorkItem[] = [];
    for (const item of recovery?.items ?? []) {
      items.push({
        key: `recovery-${item.id}`,
        kind: 'recovery',
        title: item.invoice_number ? `Invoice ${item.invoice_number}` : 'Recovery item',
        meta: item.detail,
        amount: null,
        status: 'Reconcile',
        href: '/ops/recovery',
        createdAt: item.created_at,
        priority: 0,
      });
    }
    for (const row of reviews?.records ?? []) {
      const client = row.companyClientId ? reviews?.clientNames[row.companyClientId] ?? row.companyClientId : 'Client';
      const debtor = row.companyDebtorId ? reviews?.debtorNames[row.companyDebtorId] ?? row.companyDebtorId : null;
      items.push({
        key: `review-${row.reviewId ?? row.id}`,
        kind: 'review',
        title: `Invoice ${row.invoiceNumber ?? row.id.slice(0, 8)}`,
        meta: [client, debtor, row.reason].filter(Boolean).join(' · '),
        amount: row.invoiceAmount,
        status: 'Review',
        href: row.submissionId ? `/ops/submissions/${encodeURIComponent(row.submissionId)}` : '/ops/reviews',
        createdAt: row.createdAt ?? '',
        priority: 1,
      });
    }
    for (const run of runs) {
      if (run.state !== 'APPROVED' && run.state !== 'SUGGESTED') continue;
      items.push({
        key: `funding-${run.id}`,
        kind: 'funding',
        title: `Invoice ${run.invoiceNumber ?? run.factorCloudInvoiceId.slice(0, 8)}`,
        meta: [run.clientName, run.reasons[0] ?? run.detail ?? (run.state === 'APPROVED' ? 'Approved and waiting to fund' : 'Automation suggestion')].filter(Boolean).join(' · '),
        amount: run.amount,
        status: run.state === 'APPROVED' ? 'Fund' : 'Approve',
        href: '/ops/funding',
        createdAt: run.createdAt,
        priority: run.state === 'APPROVED' ? 2 : 3,
      });
    }
    return items
      .sort((a, b) => a.priority - b.priority || timestamp(b.createdAt) - timestamp(a.createdAt))
      .slice(0, 8);
  }, [recovery, reviews, runs]);

  const filteredClients = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const clients = [...(ops?.clients ?? [])].sort((a, b) => b.invoiceAmount - a.invoiceAmount);
    return needle ? clients.filter((client) => client.clientName.toLowerCase().includes(needle) || client.clientId.toLowerCase().includes(needle)) : clients;
  }, [ops, query]);

  const recentRuns = [...runs].sort((a, b) => timestamp(b.fundedAt ?? b.createdAt) - timestamp(a.fundedAt ?? a.createdAt)).slice(0, 7);
  const heldCount = runs.filter((run) => run.state === 'APPROVED' || (run.state === 'SUGGESTED' && run.outcome === 'HOLD')).length;
  const failedCount = runs.filter((run) => run.state === 'FAILED' || run.state === 'FUNDING').length;
  const fundedCount = runs.filter((run) => run.state === 'FUNDED').length;
  const ninetyPlus = ops?.analytics.aging.totals[3] ?? 0;

  return <main className={`opsShell ${styles.page}`}>
    <OpsSidebar active="overview" />
    <section className="opsContent">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.headerMeta}>
            <span className="eyebrow">Factor operations</span>
            {ops?.demo ? <DemoBadge /> : <span className={styles.livePill}>Live FactorCloud data</span>}
            {funding?.available && <span className={styles.modePill} data-mode={funding.mode}>{MODE_LABEL[funding.mode]}</span>}
          </div>
          <h1>Automation Center</h1>
          <p>Work the exceptions. Clean invoices move through the rules automatically, while reviews, funding holds and uncertain outcomes stay visible until a person resolves them.</p>
        </div>
        <div className={styles.headerActions}>
          <a className={styles.secondaryAction} href="/ops/rules">Rules & automation</a>
          <button className={styles.primaryAction} onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </header>

      {warnings.length > 0 && <div className={styles.alert}><strong>Some automation data could not be loaded.</strong> {warnings.join(' | ')}</div>}
      {ops?.source.complete === false && <div className={styles.alert}><strong>Portfolio totals may be incomplete.</strong> {ops.source.note}</div>}
      {funding && !funding.available && <div className={styles.alert}><strong>Funding automation is unavailable.</strong> {funding.note ?? 'Database sign-in is required.'}</div>}

      {loading && !ops && !funding && !reviews && !recovery ? <DashboardSkeleton /> : <>
        <section className={styles.metricGrid}>
          <MetricCard href="/ops/reviews" label="Needs review" value={reviewCount} detail={reviewCount ? 'Paperwork or validation needs a factor decision' : 'No paperwork exceptions waiting'} icon="R" tone={reviewCount ? 'review' : 'good'} />
          <MetricCard href="/ops/funding" label="Ready to fund" value={readyToFund.length} detail={`${formatMoney(readyToFund.reduce((sum, run) => sum + run.amount, 0))} approved, not funded`} icon="$" tone={readyToFund.length ? 'review' : 'good'} />
          <MetricCard href="/ops/recovery" label="Recovery" value={recoveryCount} detail={recoveryCount ? 'Uncertain or interrupted operations need reconciliation' : 'No open reconciliation items'} icon="!" tone={recoveryCount ? 'danger' : 'good'} />
          <MetricCard href="/ops/funding" label="Auto-funded today" value={autoFundedToday.length} detail={`${formatMoney(autoFundedToday.reduce((sum, run) => sum + run.amount, 0))} funded automatically`} icon="✓" tone="good" />
        </section>

        <section className={styles.mainGrid}>
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardHeaderCopy}><span className={styles.kicker}>Priority work</span><h2>What needs a person</h2><p>Recovery first, then review and funding actions.</p></div>
              <a className={styles.cardLink} href="/ops/funding">Open funding →</a>
            </div>
            <div className={styles.queue}>
              {work.map((item) => <a className={styles.queueRow} data-kind={item.kind} href={item.href} key={item.key}>
                <span className={styles.queueBadge}>{item.kind === 'recovery' ? '!' : item.kind === 'review' ? 'R' : '$'}</span>
                <span className={styles.queueIdentity}><strong>{item.title}</strong><span>{item.meta}</span></span>
                <span className={styles.queueAmount}>{item.amount != null && <strong>{formatMoney(item.amount)}</strong>}<span>{item.status}</span></span>
              </a>)}
              {!work.length && <div className={styles.empty}>Nothing needs a person right now. Clean automation is doing the work.</div>}
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardHeaderCopy}><span className={styles.kicker}>Engine status</span><h2>Automation health</h2><p>Current recorded decisions in the portal.</p></div>
              <a className={styles.cardLink} href="/ops/rules">Configure →</a>
            </div>
            <div className={styles.healthBody}>
              <div className={styles.healthHero}>
                <span>Current mode</span>
                <strong>{funding ? MODE_LABEL[funding.mode] : 'Unavailable'}</strong>
                <small>{funding?.mode === 'fund' ? 'Clean invoices can approve and fund automatically within the active rules and caps.' : funding?.mode === 'approve' ? 'Clean invoices can be approved automatically, but funding still needs a person.' : funding?.mode === 'suggest' ? 'The engine evaluates invoices but does not make FactorCloud funding decisions on its own.' : 'The funding engine is not currently taking automatic action.'}</small>
              </div>
              <div className={styles.healthRows}>
                <HealthRow label="Recorded decisions" value={runs.length} />
                <HealthRow label="Funded" value={fundedCount} />
                <HealthRow label="Held / waiting" value={heldCount} />
                <HealthRow label="Paperwork review" value={runs.filter((run) => run.state === 'REVIEW').length} />
                <HealthRow label="Failed / uncertain" value={failedCount} />
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}><div><h2>Recent automation activity</h2><p>Newest funding-engine decisions, with portfolio context beside them.</p></div></div>
          <div className={styles.activityGrid}>
            <div className={styles.card}>
              <div className={styles.activityList}>
                {recentRuns.map((run) => <div className={styles.activityRow} key={run.id}>
                  <span className={styles.activityDot} data-state={run.state} />
                  <span className={styles.activityIdentity}><strong>Invoice {run.invoiceNumber ?? run.factorCloudInvoiceId.slice(0, 8)} · {stateLabel(run)}</strong><span>{[run.clientName, run.reasons[0] ?? run.detail].filter(Boolean).join(' · ') || 'No exception reason recorded'}</span></span>
                  <span className={styles.activityTime}>{shortTime(run.fundedAt ?? run.createdAt)}</span>
                </div>)}
                {!recentRuns.length && <div className={styles.empty}>Automation decisions will appear here as invoices move through the engine.</div>}
              </div>
            </div>

            <div className={styles.card}>
              <div className={styles.cardHeader}><div className={styles.cardHeaderCopy}><span className={styles.kicker}>Today</span><h2>Flow at a glance</h2></div></div>
              <div className={styles.healthBody}>
                <HealthRow label="Clean arrivals" value={ops?.portfolio.arrivedToday.available ? ops.portfolio.arrivedToday.count : '—'} />
                <HealthRow label="Auto-funded" value={autoFundedToday.length} />
                <HealthRow label="Waiting for review" value={reviewCount} />
                <HealthRow label="Waiting to fund" value={readyToFund.length} />
                <HealthRow label="Recovery items" value={recoveryCount} />
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section} id="portfolio">
          <div className={styles.sectionHeading}><div><h2>Portfolio context</h2><p>Useful risk and client context, secondary to the automation work queues.</p></div><a className={styles.cardLink} href="/ops/debtors">View debtors →</a></div>
          <div className={styles.portfolioMetrics}>
            <PortfolioMetric label="Open A/R" value={formatMoney(ops?.analytics.kpis.openBalance ?? 0)} detail={`${ops?.analytics.kpis.openCount ?? 0} open invoices`} />
            <PortfolioMetric label="90+ days" value={formatMoney(ninetyPlus)} detail="Oldest aging bucket" />
            <PortfolioMetric label="Active clients" value={ops?.totals.clientCount ?? 0} detail={`${ops?.totals.invoiceCount ?? 0} invoices loaded`} />
            <PortfolioMetric label="Days to collect" value={ops?.analytics.kpis.dsoLast90 == null ? '—' : `${ops.analytics.kpis.dsoLast90.toFixed(1)}d`} detail="Last 90 days" />
          </div>

          <div className={styles.clientPanel}>
            <div className={styles.clientToolbar}><strong>Clients</strong><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search clients" /></div>
            <div className={styles.clientRows}>
              {filteredClients.slice(0, 12).map((client) => <a className={styles.clientRow} href={`/ops/clients/${encodeURIComponent(client.clientId)}`} key={client.clientId}>
                <span className={styles.clientName}><strong>{client.clientName}</strong><span>{client.latestInvoiceDate ? `Latest invoice ${client.latestInvoiceDate}` : 'No recent invoice date'}</span></span>
                <span className={styles.clientCell}>{client.invoiceCount} invoices</span>
                <span className={styles.clientCell}>{formatMoney(client.invoiceAmount)}</span>
                <span className={styles.clientArrow}>›</span>
              </a>)}
              {!filteredClients.length && <div className={styles.empty}>No clients match that search.</div>}
            </div>
          </div>
        </section>
      </>}
    </section>
  </main>;
}

function MetricCard({ href, label, value, detail, icon, tone }: { href: string; label: string; value: number | string; detail: string; icon: string; tone: 'review' | 'danger' | 'good' }) {
  return <a className={styles.metricCard} data-tone={tone} href={href}><span className={styles.metricTop}><span className={styles.metricLabel}>{label}</span><span className={styles.metricIcon}>{icon}</span></span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricDetail}>{detail}</span></a>;
}

function HealthRow({ label, value }: { label: string; value: number | string }) {
  return <div className={styles.healthRow}><span>{label}</span><strong>{value}</strong></div>;
}

function PortfolioMetric({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return <div className={styles.portfolioMetric}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Could not load ${url}.`);
  return body as T;
}

function stateLabel(run: FundingRun): string {
  if (run.state === 'FUNDED') return run.autoFunded ? 'Auto-funded' : 'Funded';
  if (run.state === 'APPROVED') return 'Approved, needs funding';
  if (run.state === 'FUNDING') return 'Funding outcome uncertain';
  if (run.state === 'FAILED') return 'Approval failed';
  if (run.state === 'REVIEW') return 'Paperwork review';
  if (run.outcome === 'FUND') return 'Would fund';
  if (run.outcome === 'HOLD') return 'Would hold';
  return 'Suggested review';
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
}

function shortTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function isToday(value: string | null): boolean {
  if (!value) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toDateString() === new Date().toDateString();
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
