'use client';

import { useEffect, useMemo, useState } from 'react';
import { ActivityTrendChart, RankBars, StatusDonut, money } from '@/app/components/DashboardCharts';
import { DashboardViewSwitcher, type DashboardPreset, type DashboardWidgetOption } from '@/app/components/DashboardViews';
import { PortalNav } from '@/app/components/PortalNav';
import { averageInvoiceAmount, buildStatusMix, buildWeeklyActivity, periodAmount, trendPercent } from '@/lib/dashboard';
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
  { id: 'overview', label: 'Overview', description: 'The full client picture', widgets: ['metrics', 'pipeline', 'cash', 'trend', 'status', 'recent', 'alerts', 'concentration', 'quick-actions'] },
  { id: 'cash', label: 'Cash', description: 'Funding, reserves and collections', widgets: ['metrics', 'pipeline', 'cash', 'debtor-aging', 'dso'] },
  { id: 'activity', label: 'Activity', description: 'Invoice pace and statuses', widgets: ['metrics', 'trend', 'status', 'recent'] },
  { id: 'debtors', label: 'Debtors', description: 'Concentration and exceptions', widgets: ['metrics', 'concentration', 'alerts', 'status'] },
  { id: 'reviews', label: 'Reviews', description: 'Portal review workload', widgets: ['metrics', 'recent', 'alerts', 'quick-actions'] },
];

const CLIENT_WIDGETS: DashboardWidgetOption[] = [
  { id: 'pipeline', label: 'Invoice pipeline', description: 'Submitted, verified, funded and paid at a glance' },
  { id: 'cash', label: 'Cash panel', description: 'Advances, reserve held and expected releases' },
  { id: 'debtor-aging', label: 'Debtor aging', description: 'Open balances by debtor and age' },
  { id: 'dso', label: 'Days to pay', description: 'How fast your debtors pay, month by month' },
  { id: 'metrics', label: 'Key metrics', description: '30-day activity, average size, reviews and concentration' },
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
  const averageInvoice = useMemo(() => averageInvoiceAmount(data?.records ?? []), [data]);
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
  const topConcentration = data?.concentrations[0];
  const openReviews = workflowCounts.get('REVIEW_REQUIRED') ?? 0;
  const show = (widget: string) => visibleWidgets.includes(widget);

  return (
    <main className="portalShell dashboardPage">
      <PortalNav active="home" />

      <section className="portalWelcome dashboardHero">
        <div>
          <div className="dashboardHeroMeta"><span className="eyebrow">FactorCloud Client Portal</span>{data?.demo ? <DemoBadge /> : <span className="dashLiveBadge"><i />Live account data</span>}</div>
          <h1>{loading && !data ? 'Loading your account...' : `Good to see you, ${data?.source.clientName ? shortName(data.source.clientName) : portalConfig.clientShortName}`}</h1>
          <p>Track invoice activity, review exceptions, and debtor concentration without digging through separate screens.</p>
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
          <DashMetric icon="$" label="30-day activity" value={<CountUp value={last30Amount} format={(v) => money(v)} />} detail={trendCopy(thirtyDayTrend, 'vs. prior 30 days')} trend={thirtyDayTrend} />
          <DashMetric icon="7" label="Last 7 days" value={<CountUp value={data.last7Amount} format={(v) => money(v)} />} detail={data.volumeRatio == null ? 'Building a weekly baseline' : `${data.volumeRatio.toFixed(1)}x prior weekly pace`} trend={data.volumeRatio == null ? null : (data.volumeRatio - 1) * 100} />
          <DashMetric icon="Ø" label="Average invoice" value={money(averageInvoice)} detail={`${data.invoiceCount} invoice${data.invoiceCount === 1 ? '' : 's'} in loaded history`} />
          <DashMetric icon="!" label="Portal reviews" value={openReviews} detail={openReviews ? 'Waiting on factor review' : 'Nothing waiting for review'} tone={openReviews ? 'review' : 'good'} />
          <DashMetric icon="%" label="Top debtor share" value={topConcentration ? `${Math.round(topConcentration.share * 100)}%` : '-'} detail={topConcentration?.debtorName || 'No concentration data yet'} tone={topConcentration?.level === 'HIGH' ? 'bad' : topConcentration?.level === 'REVIEW' ? 'review' : 'good'} />
        </section>}

        <section className="dashBoard">
          {show('pipeline') && <DashboardCard className="dashSpan8" kicker="Invoice pipeline" title="From submitted to paid" action={<a href="/invoices">Track invoices</a>}>
            <LifecyclePipeline stages={data.cash.pipeline} />
            <p className="dashCardFootnote">Paid shows the last 30 days.</p>
          </DashboardCard>}

          {show('cash') && <DashboardCard className="dashSpan4" kicker="Your cash" title="Money in motion">
            <CashPanel cash={data.cash} />
          </DashboardCard>}

          {show('debtor-aging') && <DashboardCard className="dashSpan8" kicker="Receivables" title="Open balance by debtor">
            <AgingBars aging={data.debtorAging} />
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

function CashPanel({ cash }: { cash: CashSummary }) {
  return <div className="cashPanel">
    <div className="cashHero"><span>Open with debtors</span><strong><CountUp value={cash.openBalance} format={(v) => money(v)} /></strong><small>{cash.avgDaysToPay == null ? 'Payment pace builds as invoices are paid' : `Debtors pay in about ${Math.round(cash.avgDaysToPay)} days`}</small></div>
    <div className="cashRows">
      <div><i style={{ background: '#2a78d6' }} /><span>Advanced to you, 30 days</span><strong>{compactMoney(cash.advancedLast30)}</strong></div>
      <div><i style={{ background: '#86b6ef' }} /><span>Reserve held</span><strong>{compactMoney(cash.reserveHeld)}</strong></div>
      <div><i style={{ background: '#eb6834' }} /><span>Reserve expected back, next 30 days</span><strong>{compactMoney(cash.expectedRelease30)}</strong></div>
      <div><i style={{ background: '#c3c2b7' }} /><span>Fees, 30 days</span><strong>{compactMoney(cash.feesLast30)}</strong></div>
    </div>
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
