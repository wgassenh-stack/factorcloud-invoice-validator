'use client';

import { useEffect, useMemo, useState } from 'react';
import { ActivityTrendChart, RankBars, StatusDonut, money } from '@/app/components/DashboardCharts';
import { DashboardViewSwitcher, type DashboardPreset, type DashboardWidgetOption } from '@/app/components/DashboardViews';
import { PortalNav } from '@/app/components/PortalNav';
import { buildStatusMix, buildWeeklyActivity, periodAmount, trendPercent } from '@/lib/dashboard';
import { portalConfig } from '@/lib/portal-config';
import { lifecycleStage, type AgingSummary, type CashSummary, type DsoPoint } from '@/lib/analytics';
import type { RiskInvoiceRecord } from '@/lib/risk';
import { AgingBars, CountUp, DashboardSkeleton, DsoLine, LifecyclePipeline, compactMoney } from '@/app/components/CommandCharts';
import { DemoBadge } from '@/app/components/DemoBadge';
import { FixRequestsBanner } from '@/app/components/FixRequests';

type RiskRecord = RiskInvoiceRecord;

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

type PortalWorkflowSummary = {
  workflowStatus: string;
  validationStatus: string;
  updatedAt: string;
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
  portalWorkflows?: Record<string, PortalWorkflowSummary>;
  cash: CashSummary;
  debtorAging: AgingSummary;
  dso: DsoPoint[];
  demo?: boolean;
  source: {
    clientId: string;
    clientName: string;
    returnedInvoiceCount: number;
    clientInvoiceCount: number;
    complete?: boolean;
    note: string;
  };
};

const CLIENT_PRESETS: DashboardPreset[] = [
  { id: 'overview', label: 'Overview', description: 'Your money and what needs you', widgets: ['metrics', 'pipeline', 'cash', 'debtor-aging', 'attention', 'recent', 'quick-actions'] },
  { id: 'cash', label: 'Cash', description: 'Funding, reserves and collections', widgets: ['metrics', 'pipeline', 'cash', 'debtor-aging', 'dso'] },
  { id: 'activity', label: 'Activity', description: 'Invoice pace and statuses', widgets: ['metrics', 'trend', 'status', 'recent'] },
  { id: 'debtors', label: 'Debtors', description: 'Concentration and exceptions', widgets: ['metrics', 'concentration', 'alerts', 'status'] },
  { id: 'reviews', label: 'Reviews', description: 'Portal review workload', widgets: ['metrics', 'recent', 'alerts', 'quick-actions'] },
];

const CLIENT_WIDGETS: DashboardWidgetOption[] = [
  { id: 'pipeline', label: 'Invoice pipeline', description: 'Submitted, verified, funded and paid at a glance' },
  { id: 'cash', label: 'Where your money is', description: 'Paid to you, the fee and the reserve coming back' },
  { id: 'attention', label: 'Needs attention', description: 'Late payers, slow approvals and rejected invoices' },
  { id: 'debtor-aging', label: 'Debtor aging', description: 'Open balances by debtor and age' },
  { id: 'dso', label: 'Days to pay', description: 'How fast your debtors pay, month by month' },
  { id: 'metrics', label: 'Key metrics', description: 'Billed, paid to you, waiting on the factor, reserve and late invoices' },
  { id: 'trend', label: 'Activity trend', description: 'Eight weeks of invoice amount and volume' },
  { id: 'status', label: 'Status mix', description: 'How invoices are distributed across FactorCloud statuses' },
  { id: 'recent', label: 'Recent invoices', description: 'Latest invoice activity with review context' },
  { id: 'alerts', label: 'Alerts', description: 'Concentration and volume signals that need attention' },
  { id: 'concentration', label: 'Debtor concentration', description: 'Top debtors by share of invoice activity' },
  { id: 'quick-actions', label: 'Quick actions', description: 'Shortcuts to submit, search and review' },
];

export default function ClientPortalHome() {
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [visibleWidgets, setVisibleWidgets] = useState<string[]>(CLIENT_PRESETS[0].widgets);

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
    .slice(0, 7), [data]);

  const trend = useMemo(() => buildWeeklyActivity(data?.records ?? [], 8), [data]);
  const statusMix = useMemo(() => buildStatusMix(data?.records ?? []), [data]);
  const last30Amount = useMemo(() => periodAmount(data?.records ?? [], 30), [data]);
  const prior30Amount = useMemo(() => periodAmount(data?.records ?? [], 30, new Date(), 30), [data]);
  const thirtyDayTrend = trendPercent(last30Amount, prior30Amount);

  const workflowCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const workflow of Object.values(data?.portalWorkflows ?? {})) {
      counts.set(workflow.workflowStatus, (counts.get(workflow.workflowStatus) ?? 0) + 1);
    }
    return counts;
  }, [data]);

  const debtorNames = useMemo(() => Object.fromEntries((data?.concentrations ?? []).map((row) => [row.debtorId, row.debtorName])), [data]);
  const rejectedLast30 = useMemo(() => {
    const since = Date.now() - 30 * 86_400_000;
    return (data?.records ?? []).filter((r) => (r.status ?? '').toUpperCase() === 'REJECTED' && Date.parse(r.invoiceDate ?? '') >= since);
  }, [data]);
  const openReviews = workflowCounts.get('REVIEW_REQUIRED') ?? 0;
  const show = (widget: string) => visibleWidgets.includes(widget);

  return (
    <main className="portalShell dashboardPage">
      <PortalNav active="home" />

      <section className="portalWelcome dashboardHero">
        <div>
          <div className="dashboardHeroMeta"><span className="eyebrow">FactorCloud Client Portal</span>{data?.demo ? <DemoBadge /> : <span className="dashLiveBadge"><i />Live account data</span>}</div>
          <h1>{loading && !data ? 'Loading your account...' : `Good to see you, ${data?.source.clientName ? shortName(data.source.clientName) : portalConfig.clientShortName}`}</h1>
          <p>See what you've billed, what's been paid to you, and what still needs you, all in one place.</p>
        </div>
        <div className="portalWelcomeActions">
          <a className="primaryLink" href="/submit">+ Submit invoice</a>
          <a className="secondaryLink" href="/invoices">View invoices</a>
        </div>
      </section>

      <DashboardViewSwitcher
        storageKey="factorcloud-client-dashboard-views-v1"
        presets={CLIENT_PRESETS}
        widgets={CLIENT_WIDGETS}
        onWidgetsChange={setVisibleWidgets}
      />

      <FixRequestsBanner />

      {data?.source.complete === false && <div className="attentionSummary review"><strong>Some invoices may be missing</strong><span>Not every invoice could be loaded from FactorCloud, so totals below may be incomplete. Try again shortly.</span></div>}
      {error && <div className="attentionSummary fail"><strong>Could not load FactorCloud data</strong><span>{error}</span><button className="small retryButton" onClick={() => void load()}>Try again</button></div>}

      {loading && !data && <DashboardSkeleton />}

      {data && <>
        {show('metrics') && <section className="dashMetricGrid">
          <DashMetric icon="$" label="Billed, 30 days" value={<CountUp value={last30Amount} format={(v) => money(v)} />} detail={trendCopy(thirtyDayTrend, 'vs. prior 30 days')} trend={thirtyDayTrend} />
          <DashMetric icon="↓" label="Paid to you, 30 days" value={<CountUp value={data.cash.last30.advanced + data.cash.last30.reserveReleased} format={(v) => money(v)} />} detail={`${compactMoney(data.cash.last30.advanced)} advances + ${compactMoney(data.cash.last30.reserveReleased)} reserve back`} tone="good" />
          <DashMetric icon="⏳" label="Waiting on the factor" value={<CountUp value={data.cash.waitingOnFactor.amount} format={(v) => money(v)} />} detail={data.cash.waitingOnFactor.count ? `${data.cash.waitingOnFactor.count} not funded yet · oldest ${data.cash.waitingOnFactor.oldestDays ?? 0}d` : 'Everything sent in is funded'} tone={(data.cash.waitingOnFactor.oldestDays ?? 0) > SLOW_APPROVAL_DAYS ? 'review' : 'good'} />
          <DashMetric icon="↺" label="Reserve coming back" value={<CountUp value={data.cash.withDebtors.reserveBack} format={(v) => money(v)} />} detail="Paid to you as debtors pay" />
          <DashMetric icon="!" label="Unpaid 60+ days" value={money(data.cash.over60.amount)} detail={data.cash.over60.count ? `${data.cash.over60.count} invoice${data.cash.over60.count === 1 ? '' : 's'} · chase or expect a charge-back` : 'No late debtor payments'} tone={data.cash.over60.count ? 'bad' : 'good'} />
        </section>}

        <section className="dashBoard">
          {show('pipeline') && <DashboardCard className="dashSpan8" kicker="Invoice pipeline" title="From submitted to paid" action={<a href="/invoices">Track invoices</a>}>
            <LifecyclePipeline stages={data.cash.pipeline} />
            <p className="dashCardFootnote">Paid shows the last 30 days.</p>
          </DashboardCard>}

          {show('cash') && <DashboardCard className="dashSpan4" kicker="Your money" title="Where your money is">
            <CashPanel cash={data.cash} />
          </DashboardCard>}

          {show('debtor-aging') && <DashboardCard className="dashSpan8" kicker="Who owes you" title="Unpaid funded invoices by debtor">
            <AgingBars aging={data.debtorAging} />
            <p className="dashCardFootnote">Darker means older. Your reserve on these comes back only when the debtor pays, and invoices left unpaid too long are usually charged back to you.</p>
          </DashboardCard>}

          {show('attention') && <DashboardCard className="dashSpan4" kicker="Attention" title="Needs attention" action={<a href="/invoices">Track invoices</a>}>
            <ClientAttention cash={data.cash} rejected={rejectedLast30.length} inReview={openReviews} />
          </DashboardCard>}

          {show('dso') && <DashboardCard className="dashSpan4" kicker="Collections" title="Days for debtors to pay">
            <DsoLine points={data.dso} />
          </DashboardCard>}

          {show('trend') && <DashboardCard className="dashSpan8" kicker="Invoice activity" title="Eight-week volume trend" action={<a href="/invoices">Explore invoices</a>}>
            <div className="dashCardStatline"><strong>{money(trend.reduce((sum, point) => sum + point.amount, 0))}</strong><span>{trend.reduce((sum, point) => sum + point.count, 0)} invoices across the last eight calendar weeks</span></div>
            <ActivityTrendChart points={trend} />
          </DashboardCard>}

          {show('status') && <DashboardCard className="dashSpan4" kicker="FactorCloud status" title="Where invoices stand">
            <StatusDonut items={statusMix} centerValue={data.invoiceCount} centerLabel="Invoices" />
          </DashboardCard>}

          {show('recent') && <DashboardCard className="dashSpan8" kicker="Recent activity" title="Latest invoices" action={<a href="/invoices">View all</a>}>
            <div className="dashInvoiceRows">
              {recent.map((record) => {
                const workflow = data.portalWorkflows?.[record.id];
                return <a className="dashInvoiceRow" href={`/invoices/${encodeURIComponent(record.id)}`} key={record.id}>
                  <div className="dashInvoiceGlyph">{statusInitial(record.status)}</div>
                  <div className="dashInvoiceIdentity">
                    <strong>Invoice {record.invoiceNumber || record.id.slice(0, 8)}</strong>
                    <span>{record.companyDebtorId ? debtorNames[record.companyDebtorId] || 'FactorCloud debtor' : 'Debtor unavailable'} · {record.invoiceDate || 'No date'}</span>
                  </div>
                  <div className="dashInvoiceStatuses">
                    <MiniStages record={record} />
                    {workflow && <span className={`dashReviewPill ${workflowTone(workflow.workflowStatus)}`}>{pretty(workflow.workflowStatus)}</span>}
                  </div>
                  <strong>{record.invoiceAmount == null ? '-' : money(record.invoiceAmount)}</strong>
                </a>;
              })}
              {!recent.length && <div className="portalEmpty"><strong>No invoice activity yet</strong><span>Submit your first invoice to start building this dashboard.</span></div>}
            </div>
          </DashboardCard>}

          {show('alerts') && <DashboardCard className="dashSpan4" kicker="Attention" title="Signals to review" action={<a href="/risk">Open alerts</a>}>
            <div className="dashAlertStack">
              {data.alerts.slice(0, 5).map((alert) => <div className={`dashAlertItem ${alert.level.toLowerCase()}`} key={alert.id}>
                <span className="dashAlertIcon">!</span>
                <div><strong>{alert.title}</strong><span>{alert.detail}</span></div>
              </div>)}
              {!data.alerts.length && <div className="dashAllClear"><span>✓</span><div><strong>Nothing needs attention</strong><small>No concentration or volume signal is currently triggered.</small></div></div>}
            </div>
          </DashboardCard>}

          {show('concentration') && <DashboardCard className="dashSpan8" kicker="Debtor mix" title="Concentration by invoice activity" action={<a href="/risk">See thresholds</a>}>
            <RankBars
              items={data.concentrations.slice(0, 6).map((row) => ({
                id: row.debtorId,
                label: row.debtorName,
                value: row.amount,
                detail: `${row.invoiceCount} invoice${row.invoiceCount === 1 ? '' : 's'} · ${Math.round(row.share * 100)}% share`,
              }))}
            />
          </DashboardCard>}

          {show('quick-actions') && <DashboardCard className="dashSpan4" kicker="Shortcuts" title="Get something done">
            <div className="dashQuickGrid">
              <QuickAction href="/submit" icon="↑" title="Submit invoice" detail="Upload, verify, and send a funding packet" />
              <QuickAction href="/invoices" icon="#" title="Find an invoice" detail="Search FactorCloud and portal review status" />
              {portalConfig.features.batch && <QuickAction href="/batch" icon="≡" title="Batch upload" detail="Process multiple invoice packets" />}
              {portalConfig.features.alerts && <QuickAction href="/risk" icon="!" title="Review alerts" detail="Inspect concentration and volume signals" />}
            </div>
          </DashboardCard>}
        </section>

        <p className="portalDataNote">{data.source.note} Cash and aging figures come from FactorCloud's balance, advance, reserve, funded and paid fields.</p>
      </>}
    </main>
  );
}

const SLOW_APPROVAL_DAYS = 3;
const SPLIT = { advanced: '#2a78d6', fees: '#c3c2b7', reserveBack: '#eb6834', notBrokenOut: '#ecebe5' };

function CashPanel({ cash }: { cash: CashSummary }) {
  const d = cash.withDebtors;
  const parts = [
    { key: 'advanced', label: 'Already paid to you', value: d.advanced, color: SPLIT.advanced },
    { key: 'fees', label: "Factor's fee", value: d.fees, color: SPLIT.fees },
    { key: 'reserveBack', label: 'Comes back to you when paid', value: d.reserveBack, color: SPLIT.reserveBack },
    { key: 'notBrokenOut', label: 'Not broken out in FactorCloud', value: d.notBrokenOut, color: SPLIT.notBrokenOut },
  ].filter((part) => part.key !== 'notBrokenOut' || part.value > 0)
    .map((part) => ({ ...part, value: Math.round(part.value) }));
  // Rounded to whole dollars, the biggest part (the advance) absorbs the rounding so the rows add up
  // exactly on screen and the reserve matches the "Reserve coming back" tile.
  const biggest = parts.reduce((a, b) => (b.value > a.value ? b : a));
  biggest.value = Math.round(d.amount) - parts.filter((part) => part !== biggest).reduce((sum, part) => sum + part.value, 0);
  const recent = cash.last30.advanced + cash.last30.reserveReleased;

  return <div className="cashPanel">
    <div className="cashHero">
      <span>Funded, waiting on debtors</span>
      <strong><CountUp value={d.amount} format={(v) => money(v)} /></strong>
      <small>{d.count} invoice{d.count === 1 ? '' : 's'}{cash.avgDaysToPay == null ? '' : ` · debtors pay in about ${Math.round(cash.avgDaysToPay)} days`}</small>
    </div>
    {d.amount > 0 && <div className="cashSplitBar" role="img" aria-label={parts.map((p) => `${p.label} ${money(p.value)}`).join(', ')}>
      {parts.map((part) => part.value > 0 && <i key={part.key} style={{ flexGrow: part.value, background: part.color }} title={`${part.label}: ${money(part.value)}`} />)}
    </div>}
    <div className="cashRows">
      {parts.map((part) => <div key={part.key}><i style={{ background: part.color }} /><span>{part.label}</span><strong>{money(part.value)}</strong></div>)}
      <div className="cashTotal"><i /><span>Adds up to</span><strong>{money(d.amount)}</strong></div>
    </div>
    <div className="cashFoot">
      {d.amount - d.stillOwed >= 1 && <p><strong>Paid off so far:</strong> debtors have already paid {money(d.amount - d.stillOwed)} of this, so they still owe {money(d.stillOwed)}.</p>}
      <p><strong>Waiting on the factor:</strong> {cash.waitingOnFactor.count ? `${money(cash.waitingOnFactor.amount)} on ${cash.waitingOnFactor.count} invoice${cash.waitingOnFactor.count === 1 ? '' : 's'} not funded yet.` : 'nothing, every invoice you sent is funded.'}</p>
      <p><strong>Last 30 days:</strong> {money(recent)} paid to you ({money(cash.last30.advanced)} advances + {money(cash.last30.reserveReleased)} reserve back). Fees on invoices paid: {money(cash.last30.fees)}.</p>
    </div>
  </div>;
}

function ClientAttention({ cash, rejected, inReview }: { cash: CashSummary; rejected: number; inReview: number }) {
  const items: { tone: 'high' | 'review'; title: string; detail: string }[] = [];
  if (cash.over60.count) items.push({ tone: 'high', title: `${money(cash.over60.amount)} unpaid 60+ days`, detail: `${cash.over60.count} funded invoice${cash.over60.count === 1 ? ' is' : 's are'} late. Unpaid invoices are usually charged back to you (often at 90 days), so chase these debtors.` });
  if ((cash.waitingOnFactor.oldestDays ?? 0) > SLOW_APPROVAL_DAYS) items.push({ tone: 'review', title: `Waiting on the factor for ${cash.waitingOnFactor.oldestDays} days`, detail: `${cash.waitingOnFactor.count} invoice${cash.waitingOnFactor.count === 1 ? ' is' : 's are'} not funded yet (${money(cash.waitingOnFactor.amount)}). Ask your factor if something is missing.` });
  if (rejected) items.push({ tone: 'high', title: `${rejected} rejected in the last 30 days`, detail: 'Fix the paperwork and send them in again to get paid.' });
  if (inReview) items.push({ tone: 'review', title: `${inReview} in factor review`, detail: 'The factor is checking these before funding. You will get a request here if they need anything.' });
  if (!items.length) return <div className="dashAllClear"><span>✓</span><div><strong>Nothing needs you</strong><small>No late payers, slow approvals or rejected invoices.</small></div></div>;
  return <div className="dashAlertStack">
    {items.map((item) => <div className={`dashAlertItem ${item.tone}`} key={item.title}>
      <span className="dashAlertIcon">!</span>
      <div><strong>{item.title}</strong><span>{item.detail}</span></div>
    </div>)}
  </div>;
}

const STAGES = ['SUBMITTED', 'VERIFIED', 'FUNDED', 'PAID'] as const;
function MiniStages({ record }: { record: RiskRecord }) {
  const stage = lifecycleStage(record);
  const reached = STAGES.indexOf(stage);
  const label = { SUBMITTED: 'Submitted', VERIFIED: 'Verified', FUNDED: 'Funded', PAID: 'Paid' }[stage];
  return <span className="miniStages" title={`${label} · step ${reached + 1} of 4`}>
    {STAGES.map((s, i) => <i key={s} className={i <= reached ? 'on' : ''} />)}
    <em>{label}</em>
  </span>;
}

function DashboardCard({ kicker, title, action, className = '', children }: { kicker: string; title: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return <section className={`dashCard ${className}`}>
    <div className="dashCardHeader"><div><span>{kicker}</span><h2>{title}</h2></div>{action && <div className="dashCardAction">{action}</div>}</div>
    <div className="dashCardBody">{children}</div>
  </section>;
}

function DashMetric({ icon, label, value, detail, trend, tone = '' }: { icon: string; label: string; value: React.ReactNode; detail: string; trend?: number | null; tone?: string }) {
  return <div className={`dashMetric ${tone}`}>
    <div className="dashMetricTop"><span className="dashMetricIcon">{icon}</span>{trend != null && Number.isFinite(trend) && <span className={`dashMetricTrend ${trend >= 0 ? 'up' : 'down'}`}>{trend >= 0 ? '↗' : '↘'} {Math.abs(trend).toFixed(0)}%</span>}</div>
    <span className="dashMetricLabel">{label}</span>
    <strong>{value}</strong>
    <small>{detail}</small>
  </div>;
}

function QuickAction({ href, icon, title, detail }: { href: string; icon: string; title: string; detail: string }) {
  return <a className="dashQuickAction" href={href}><span>{icon}</span><div><strong>{title}</strong><small>{detail}</small></div><b>›</b></a>;
}

function trendCopy(value: number | null, suffix: string): string {
  if (value == null) return `No prior baseline ${suffix}`;
  if (Math.abs(value) < 0.5) return `Flat ${suffix}`;
  return `${value > 0 ? '+' : ''}${value.toFixed(0)}% ${suffix}`;
}

function shortName(name: string): string {
  return name.replace(/\b(LLC|INC|CORP|CORPORATION|LTD)\.?$/i, '').trim();
}

function pretty(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusInitial(status: string | null): string {
  return (status || 'P').charAt(0).toUpperCase();
}

function statusTone(status: string | null): string {
  const value = (status || '').toUpperCase();
  if (value.includes('PAID') || value.includes('FUNDED') || value.includes('PURCHASE') || value.includes('APPROV')) return 'pass';
  if (value.includes('REJECT') || value.includes('FAIL') || value.includes('ERROR')) return 'fail';
  return 'review';
}

function workflowTone(status: string): string {
  const value = status.toUpperCase();
  if (value.includes('APPROV') || value.includes('CREATED')) return 'pass';
  if (value.includes('REJECT') || value.includes('ERROR')) return 'fail';
  return 'review';
}
