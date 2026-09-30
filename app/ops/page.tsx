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

  async function load() {
    setLoading(true);
    setWarnings([]);
    const results = await Promise.allSettled([
      fetchJson<OpsData>('/api/ops/clients'),
      fetchJson<FundingData>('/api/ops/funding'),
      fetchJson<ReviewData>('/api/ops/reviews'),
      fetchJson<RecoveryData>('/api/ops/recovery'),
    ] as const);
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
  const reviewRows = reviews?.records ?? [];
  const readyToFund = runs.filter((run) => run.state === 'APPROVED');
  const suggestions = runs.filter((run) => run.state === 'SUGGESTED');
  const autoFundedToday = runs.filter((run) => run.state === 'FUNDED' && run.autoFunded && isToday(run.fundedAt));
  const failedRuns = runs.filter((run) => run.state === 'FAILED' || run.state === 'FUNDING');
  const recoveryCount = recovery?.items.length ?? 0;
  const arrivedToday = ops?.portfolio.arrivedToday.available ? ops.portfolio.arrivedToday.count : null;

  const fundingQueue = useMemo(() => {
    return [...readyToFund, ...suggestions]
      .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt))
      .slice(0, 7);
  }, [runs]);

  const recentRuns = [...runs]
    .sort((a, b) => timestamp(b.fundedAt ?? b.createdAt) - timestamp(a.fundedAt ?? a.createdAt))
    .slice(0, 6);

  const fundedCount = runs.filter((run) => run.state === 'FUNDED').length;
  const heldCount = runs.filter((run) => run.state === 'APPROVED' || (run.state === 'SUGGESTED' && run.outcome === 'HOLD')).length;
  const reviewDecisionCount = runs.filter((run) => run.state === 'REVIEW').length;
  const decidedCount = fundedCount + heldCount + reviewDecisionCount + failedRuns.length;
  const automatedPct = decidedCount ? Math.round((fundedCount / decidedCount) * 100) : 0;

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
          <p>Real-time view of invoice intake, validation, approvals and funding. Start with the exceptions that need a person.</p>
        </div>
        <div className={styles.headerActions}>
          <a className={styles.secondaryAction} href="/ops/reports">View reports</a>
          <a className={styles.secondaryAction} href="/ops/rules">Automation rules</a>
          <button className={styles.primaryAction} onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </header>

      {warnings.length > 0 && <div className={styles.alert}><strong>Some operations data could not be loaded.</strong> {warnings.join(' | ')}</div>}
      {ops?.source.complete === false && <div className={styles.alert}><strong>Portfolio totals may be incomplete.</strong> {ops.source.note}</div>}
      {funding && !funding.available && <div className={styles.alert}><strong>Funding automation is unavailable.</strong> {funding.note ?? 'Database sign-in is required.'}</div>}

      {loading && !ops && !funding && !reviews && !recovery ? <DashboardSkeleton /> : <>
        <section className={styles.metricGridFive}>
          <MetricCard href="/ops/reviews" label="Needs review" value={reviewRows.length} detail="Paperwork exceptions" icon="R" tone={reviewRows.length ? 'review' : 'good'} />
          <MetricCard href="/ops/funding" label="Needs funding" value={readyToFund.length} detail={`${formatMoney(sumAmounts(readyToFund))} approved`} icon="$" tone={readyToFund.length ? 'review' : 'good'} />
          <MetricCard href="/ops/funding" label="Auto-funded today" value={autoFundedToday.length} detail={`${formatMoney(sumAmounts(autoFundedToday))} funded`} icon="✓" tone="good" />
          <MetricCard href="/ops/recovery" label="Failed / recovery" value={failedRuns.length + recoveryCount} detail="Needs reconciliation" icon="!" tone={failedRuns.length + recoveryCount ? 'danger' : 'good'} />
          <MetricCard href="/ops/reports" label="Submissions today" value={arrivedToday ?? '—'} detail={arrivedToday == null ? 'Arrival data unavailable' : formatMoney(ops?.portfolio.arrivedToday.amount ?? 0)} icon="→" tone="neutral" />
        </section>

        <section className={styles.commandGrid}>
          <div className={`${styles.card} ${styles.queueCard}`}>
            <div className={styles.cardHeader}>
              <div className={styles.cardHeaderCopy}><span className={styles.kicker}>Funding queue</span><h2>Ready for a decision</h2><p>Approved invoices first, then automation suggestions.</p></div>
              <a className={styles.cardLink} href="/ops/funding">Open funding center →</a>
            </div>
            <div className={styles.tableHead}>
              <span>Invoice / client</span><span>Automation decision</span><span>Amount</span><span>Action</span>
            </div>
            <div className={styles.fundingRows}>
              {fundingQueue.map((run) => <a className={styles.fundingRow} href="/ops/funding" key={run.id}>
                <span className={styles.invoiceCell}><strong>{run.invoiceNumber ?? run.factorCloudInvoiceId.slice(0, 8)}</strong><small>{run.clientName ?? 'Client not named'}</small></span>
                <span className={styles.decisionCell}><strong>{run.state === 'APPROVED' ? 'Approved, needs funding' : outcomeLabel(run)}</strong><small>{run.reasons[0] ?? run.detail ?? 'All recorded checks passed'}</small></span>
                <strong className={styles.amountCell}>{formatMoney(run.amount)}</strong>
                <span className={styles.actionPill} data-kind={run.state === 'APPROVED' ? 'fund' : 'review'}>{run.state === 'APPROVED' ? 'Fund' : 'Review'}</span>
              </a>)}
              {!fundingQueue.length && <div className={styles.empty}>No funding decisions need attention right now.</div>}
            </div>
          </div>

          <aside className={styles.rightRail}>
            <div className={`${styles.card} ${styles.performanceCard}`}>
              <div className={styles.compactHeader}><span className={styles.kicker}>Automation performance</span><a href="/ops/reports">Reports →</a></div>
              <div className={styles.performanceBody}>
                <div className={styles.donut} style={{ background: `conic-gradient(#2877df 0 ${automatedPct}%, #e9edf3 ${automatedPct}% 100%)` }}>
                  <div><strong>{automatedPct}%</strong><span>funded</span></div>
                </div>
                <div className={styles.performanceStats}>
                  <StatRow label="Funded" value={fundedCount} />
                  <StatRow label="Held / waiting" value={heldCount} />
                  <StatRow label="Review" value={reviewDecisionCount} />
                  <StatRow label="Failed / uncertain" value={failedRuns.length} />
                </div>
              </div>
            </div>

            <div className={`${styles.card} ${styles.quickCard}`}>
              <div className={styles.compactHeader}><span className={styles.kicker}>Quick actions</span></div>
              <div className={styles.quickLinks}>
                <a href="/ops/reviews"><span>Review exceptions</span><strong>{reviewRows.length}</strong></a>
                <a href="/ops/funding"><span>Funding center</span><strong>{readyToFund.length}</strong></a>
                <a href="/ops/recovery"><span>Reconcile failures</span><strong>{recoveryCount}</strong></a>
                <a href="/ops/rules"><span>Rules & automation</span><strong>→</strong></a>
                <a href="/ops/reports"><span>Portfolio reports</span><strong>→</strong></a>
              </div>
            </div>
          </aside>
        </section>

        <section className={styles.secondaryGrid}>
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardHeaderCopy}><span className={styles.kicker}>Review queue</span><h2>Paperwork exceptions</h2><p>Validation issues waiting on a factor decision.</p></div>
              <a className={styles.cardLink} href="/ops/reviews">View all →</a>
            </div>
            <div className={styles.reviewRows}>
              {reviewRows.slice(0, 6).map((row) => {
                const client = row.companyClientId ? reviews?.clientNames[row.companyClientId] ?? row.companyClientId : 'Client';
                const debtor = row.companyDebtorId ? reviews?.debtorNames[row.companyDebtorId] ?? row.companyDebtorId : null;
                return <a className={styles.reviewRow} href={row.submissionId ? `/ops/submissions/${encodeURIComponent(row.submissionId)}` : '/ops/reviews'} key={row.reviewId ?? row.id}>
                  <span className={styles.reviewIcon}>R</span>
                  <span className={styles.invoiceCell}><strong>{row.invoiceNumber ?? row.id.slice(0, 8)}</strong><small>{[client, debtor].filter(Boolean).join(' · ')}</small></span>
                  <span className={styles.reviewReason}>{row.reason ?? 'Manual review required'}</span>
                  <strong className={styles.amountCell}>{row.invoiceAmount == null ? '—' : formatMoney(row.invoiceAmount)}</strong>
                  <span className={styles.actionPill} data-kind="review">Review</span>
                </a>;
              })}
              {!reviewRows.length && <div className={styles.empty}>No paperwork exceptions are waiting.</div>}
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardHeaderCopy}><span className={styles.kicker}>Recent activity</span><h2>Automation log</h2><p>Latest funding-engine outcomes.</p></div>
            </div>
            <div className={styles.activityList}>
              {recentRuns.map((run) => <div className={styles.activityRow} key={run.id}>
                <span className={styles.activityDot} data-state={run.state} />
                <span className={styles.activityIdentity}><strong>{run.invoiceNumber ?? run.factorCloudInvoiceId.slice(0, 8)} · {stateLabel(run)}</strong><span>{run.clientName ?? run.reasons[0] ?? 'FactorCloud invoice'}</span></span>
                <span className={styles.activityTime}>{shortTime(run.fundedAt ?? run.createdAt)}</span>
              </div>)}
              {!recentRuns.length && <div className={styles.empty}>Automation activity will appear here.</div>}
            </div>
          </div>
        </section>

        <section className={styles.portfolioStrip} id="clients">
          <div>
            <span className={styles.kicker}>Portfolio snapshot</span>
            <h2>Keep operating detail on Overview, deeper analysis in Reports.</h2>
          </div>
          <div className={styles.portfolioStats}>
            <PortfolioStat label="Open A/R" value={formatMoney(ops?.analytics.kpis.openBalance ?? 0)} />
            <PortfolioStat label="Active clients" value={ops?.totals.clientCount ?? 0} />
            <PortfolioStat label="DSO" value={ops?.analytics.kpis.dsoLast90 == null ? '—' : `${ops.analytics.kpis.dsoLast90.toFixed(1)}d`} />
          </div>
          <div className={styles.portfolioActions}><a href="/ops/debtors">Debtors</a><a href="/ops/reports">Open reports →</a></div>
        </section>
      </>}
    </section>
  </main>;
}

function MetricCard({ href, label, value, detail, icon, tone }: { href: string; label: string; value: number | string; detail: string; icon: string; tone: 'review' | 'danger' | 'good' | 'neutral' }) {
  return <a className={styles.metricCard} data-tone={tone} href={href}><span className={styles.metricTop}><span className={styles.metricLabel}>{label}</span><span className={styles.metricIcon}>{icon}</span></span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricDetail}>{detail}</span></a>;
}

function StatRow({ label, value }: { label: string; value: number | string }) {
  return <div className={styles.statRow}><span>{label}</span><strong>{value}</strong></div>;
}

function PortfolioStat({ label, value }: { label: string; value: number | string }) {
  return <div className={styles.portfolioStat}><span>{label}</span><strong>{value}</strong></div>;
}

function sumAmounts(rows: FundingRun[]): number {
  return rows.reduce((sum, row) => sum + row.amount, 0);
}

function outcomeLabel(run: FundingRun): string {
  if (run.outcome === 'FUND') return 'Would fund';
  if (run.outcome === 'HOLD') return 'Would hold';
  return 'Needs review';
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
  if (run.state === 'FUNDING') return 'Funding uncertain';
  if (run.state === 'FAILED') return 'Failed';
  if (run.state === 'REVIEW') return 'Review';
  return outcomeLabel(run);
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
