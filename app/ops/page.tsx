'use client';

import { useEffect, useMemo, useState } from 'react';
import { ActivityTrendChart, RankBars, StatusDonut, money } from '@/app/components/DashboardCharts';
import { DashboardViewSwitcher, type DashboardPreset, type DashboardWidgetOption } from '@/app/components/DashboardViews';
import { OpsSignOut } from '../components/OpsSignOut';
import type { ActivityPoint, StatusMixItem } from '@/lib/dashboard';
import type { AgingSummary, DayVolume, DsoPoint, ExposureItem, MonthlyCash, PortfolioKpis } from '@/lib/analytics';
import { AgingBars, CalendarHeatmap, CashFlowBars, CountUp, DashboardSkeleton, DsoLine, ExposureTreemap, compactMoney } from '@/app/components/CommandCharts';
import { DemoBadge } from '@/app/components/DemoBadge';
import { ViewSwitch } from '@/app/components/ViewSwitch';

type OpsClientSummary = {
  clientId: string;
  clientName: string;
  invoiceCount: number;
  invoiceAmount: number;
  latestInvoiceDate: string | null;
  statuses: Record<string, number>;
};

type RecentInvoice = {
  id: string;
  invoiceNumber: string | null;
  companyClientId: string | null;
  clientName: string;
  invoiceAmount: number | null;
  invoiceDate: string | null;
  status: string | null;
};

type Arrival = {
  submissionId: string | null;
  invoiceId: string;
  invoiceNumber: string | null;
  clientId: string;
  clientName: string;
  invoiceAmount: number | null;
  documentCount: number | null;
  submittedBy: string | null;
  createdAt: string;
  status: string | null;
};

type OpsResponse = {
  clients: OpsClientSummary[];
  totals: { clientCount: number; invoiceCount: number; invoiceAmount: number };
  portfolio: {
    weeklyActivity: ActivityPoint[];
    statuses: StatusMixItem[];
    averageInvoiceAmount: number;
    last30Amount: number;
    prior30Amount: number;
    last30TrendPct: number | null;
    topClientShare: number;
    recentInvoices: RecentInvoice[];
    reviewSummary: { available: boolean; openCount: number; openAmount: number; oldestCreatedAt: string | null };
    arrivedToday: { available: boolean; count: number; amount: number; items: Arrival[] };
  };
  analytics: {
    today: string;
    kpis: PortfolioKpis;
    aging: AgingSummary;
    exposure: ExposureItem[];
    monthlyCash: MonthlyCash[];
    dso: DsoPoint[];
    daily: DayVolume[];
  };
  demo?: boolean;
  source: { returnedInvoiceCount: number; complete?: boolean; note: string };
  error?: string;
};

const FACTOR_PRESETS: DashboardPreset[] = [
  { id: 'command', label: 'Command center', description: 'Exposure, aging, cash and collections', widgets: ['kpis', 'aging', 'exposure', 'cashflow', 'dso', 'arrivals', 'reviews', 'calendar', 'clients'] },
  { id: 'operations', label: 'Operations', description: 'Reviews, volume and the latest work', widgets: ['metrics', 'arrivals', 'reviews', 'volume', 'status', 'recent', 'clients'] },
];

const FACTOR_WIDGETS: DashboardWidgetOption[] = [
  { id: 'kpis', label: 'Portfolio KPIs', description: 'Open A/R, funded, collected, fees and days to collect' },
  { id: 'aging', label: 'A/R aging', description: 'Open balances by age bucket and client' },
  { id: 'exposure', label: 'Concentration map', description: 'Treemap of open exposure by client, with flags' },
  { id: 'cashflow', label: 'Cash in vs. out', description: 'Monthly advances against collections' },
  { id: 'dso', label: 'Days to collect', description: 'Monthly trend of days from invoice to payment' },
  { id: 'calendar', label: 'Submission calendar', description: 'Daily invoice volume heatmap' },
  { id: 'metrics', label: 'Key metrics', description: '30-day activity, clients, reviews and average invoice size' },
  { id: 'volume', label: 'Volume trend', description: 'Twelve weeks of factor-wide invoice activity' },
  { id: 'top-clients', label: 'Top clients', description: 'Clients ranked by invoice activity amount' },
  { id: 'status', label: 'Status mix', description: 'FactorCloud status distribution across invoices' },
  { id: 'arrivals', label: 'Arrived today', description: 'Invoices that passed every check and went straight into FactorCloud today' },
  { id: 'reviews', label: 'Review workload', description: 'Open portal reviews and queue context' },
  { id: 'recent', label: 'Recent invoices', description: 'Latest invoice activity across clients' },
  { id: 'clients', label: 'Client table', description: 'Searchable operating view across clients' },
];

export default function FactorOperationsPage() {
  const [data, setData] = useState<OpsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [visibleWidgets, setVisibleWidgets] = useState<string[]>(FACTOR_PRESETS[0].widgets);

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

  const topClients = useMemo(() => [...(data?.clients ?? [])].sort((a, b) => b.invoiceAmount - a.invoiceAmount).slice(0, 7), [data]);
  const show = (widget: string) => visibleWidgets.includes(widget);

  return <main className="opsShell dashboardPage">
    <aside className="opsSidebar">
      <a className="opsBrand" href="/ops"><img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" /></a>
      <div className="opsRole">Factor Operations</div>
      <ViewSwitch current="staff" />
      <nav className="opsNav">
        <a className="active" href="/ops">Overview</a>
        <a href="#clients">Clients</a>
        <a href="/ops/debtors">Debtors</a>
        <a href="/ops/reviews">Review queue</a>
        <a href="/ops/funding">Funding</a>
        <a href="/ops/rules">Funding rules</a>
        <a href="/connection">Connection check</a>
      </nav>
      <div className="opsSidebarFooter"><strong>Internal view</strong><span>Factor-wide access</span><OpsSignOut /></div>
    </aside>

    <section className="opsContent">
      <header className="opsHeader dashboardHero opsDashboardHero">
        <div>
          <div className="dashboardHeroMeta"><span className="eyebrow">Factor operations</span>{data?.demo ? <DemoBadge /> : <span className="dashLiveBadge"><i />Live FactorCloud data</span>}</div>
          <h1>Portfolio command center</h1>
          <p>See client activity, review workload, and portfolio mix before drilling into the details.</p>
        </div>
        <button className="small opsRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
      </header>

      <DashboardViewSwitcher
        storageKey="factorcloud-factor-dashboard-views-v1"
        presets={FACTOR_PRESETS}
        widgets={FACTOR_WIDGETS}
        onWidgetsChange={setVisibleWidgets}
      />

      {error && <div className="attentionSummary fail"><strong>Could not load operations data</strong><span>{error}</span></div>}
      {data?.source.complete === false && <div className="attentionSummary review"><strong>Portfolio totals may be incomplete</strong><span>{data.source.note}</span></div>}

      {loading && !data && <DashboardSkeleton />}

      {data && <>
        {show('kpis') && <KpiRow kpis={data.analytics.kpis} />}
        {show('metrics') && <section className="dashMetricGrid factorMetricGrid">
          <DashMetric icon="$" label="30-day activity" value={money(data.portfolio.last30Amount)} detail={trendCopy(data.portfolio.last30TrendPct, 'vs. prior 30 days')} trend={data.portfolio.last30TrendPct} />
          <DashMetric icon="C" label="Clients with activity" value={data.totals.clientCount} detail={`${data.totals.invoiceCount} invoices in loaded history`} />
          {data.portfolio.reviewSummary.available
            ? <DashMetric icon="!" label="Open reviews" value={data.portfolio.reviewSummary.openCount} detail={data.portfolio.reviewSummary.openCount ? `${money(data.portfolio.reviewSummary.openAmount)} submitted amount` : 'Review queue is clear'} tone={data.portfolio.reviewSummary.openCount ? 'review' : 'good'} />
            : <DashMetric icon="?" label="Open reviews" value="Unavailable" detail="Could not load the portal review queue" tone="review" />}
          <DashMetric icon="Ø" label="Average invoice" value={money(data.portfolio.averageInvoiceAmount)} detail={`${money(data.totals.invoiceAmount)} total invoice activity`} />
          <DashMetric icon="%" label="Top client share" value={`${Math.round(data.portfolio.topClientShare * 100)}%`} detail={topClients[0]?.clientName || 'No client activity yet'} tone={data.portfolio.topClientShare >= .5 ? 'review' : 'good'} />
        </section>}

        <section className="dashBoard factorDashBoard">
          {show('aging') && <DashboardCard className="dashSpan7" kicker="Receivables" title="A/R aging by client" action={<span className="dashCardHint">{data.analytics.aging.openCount} open invoices</span>}>
            <AgingBars aging={data.analytics.aging} />
          </DashboardCard>}

          {show('exposure') && <DashboardCard className="dashSpan5" kicker="Concentration" title="Where the money is">
            <ExposureTreemap items={data.analytics.exposure} hrefFor={(id) => `/ops/clients/${encodeURIComponent(id)}`} />
          </DashboardCard>}

          {show('cashflow') && <DashboardCard className="dashSpan7" kicker="Cash" title="Advanced vs. collected">
            <div className="dashCardStatline"><strong>{compactMoney(data.analytics.monthlyCash.reduce((s, m) => s + m.fees, 0))}</strong><span>fees earned over twelve months</span></div>
            <CashFlowBars months={data.analytics.monthlyCash} />
          </DashboardCard>}

          {show('dso') && <DashboardCard className="dashSpan5" kicker="Collections" title="Days to collect">
            <div className="dashCardStatline"><strong>{data.analytics.kpis.dsoLast90 == null ? '-' : `${data.analytics.kpis.dsoLast90.toFixed(1)} days`}</strong><span>{dsoCopy(data.analytics.kpis)}</span></div>
            <DsoLine points={data.analytics.dso} target={40} />
          </DashboardCard>}

          {show('arrivals') && <DashboardCard className="dashSpan8" kicker="Passed every check" title="Arrived today" action={<span className="dashCardHint">Funding decisions stay in FactorCloud</span>}>
            {!data.portfolio.arrivedToday.available ? <div className="portalEmpty"><strong>Arrivals unavailable</strong><span>Could not load today's portal submissions.</span></div> : <>
              <div className="dashCardStatline"><strong>{data.portfolio.arrivedToday.count}</strong><span>{data.portfolio.arrivedToday.count === 1 ? 'clean invoice' : 'clean invoices'} today · {money(data.portfolio.arrivedToday.amount)} · no portal review needed</span></div>
              <div className="dashInvoiceRows">
                {data.portfolio.arrivedToday.items.map((a) => <a className="dashInvoiceRow factorInvoiceRow" href={a.submissionId ? `/ops/submissions/${encodeURIComponent(a.submissionId)}` : `/ops/clients/${encodeURIComponent(a.clientId)}`} key={a.submissionId ?? a.invoiceId}>
                  <div className="dashInvoiceGlyph">{(a.clientName || 'C').charAt(0).toUpperCase()}</div>
                  <div className="dashInvoiceIdentity">
                    <strong>{a.clientName}</strong>
                    <span>Invoice {a.invoiceNumber || a.invoiceId.slice(0, 8)}{a.documentCount != null ? ` · ${a.documentCount} document${a.documentCount === 1 ? '' : 's'}` : ''}{a.submittedBy ? ` · by ${a.submittedBy === 'Driver' ? 'a driver' : a.submittedBy === 'Office' ? 'the office' : a.submittedBy}` : ''}{a.createdAt.includes('T') ? ` · ${timeOfDay(a.createdAt)}` : ''}{a.status ? ` · ${pretty(a.status)} in FactorCloud` : ''}</span>
                  </div>
                  <span className="portalStatus pass">✓ All checks passed</span>
                  <strong>{a.invoiceAmount == null ? '-' : money(a.invoiceAmount)}</strong>
                </a>)}
                {!data.portfolio.arrivedToday.count && <div className="portalEmpty"><strong>Nothing yet today</strong><span>Invoices that pass every check will appear here as clients send them.</span></div>}
                {data.portfolio.arrivedToday.count > data.portfolio.arrivedToday.items.length && <span className="dashCardHint">and {data.portfolio.arrivedToday.count - data.portfolio.arrivedToday.items.length} more today</span>}
              </div>
            </>}
          </DashboardCard>}

          {show('reviews') && <DashboardCard className="dashSpan4" kicker="Portal workflow" title="Review workload" action={<a href="/ops/reviews">Open queue</a>}>
            {!data.portfolio.reviewSummary.available ? <div className="reviewWorkload">
              <div className="reviewWorkloadHero unavailable">
                <span>Review status unavailable</span>
                <strong>?</strong>
                <small>Could not load the portal review queue.</small>
              </div>
              <a className="reviewQueueLink" href="/ops/reviews">Try the review queue <span>›</span></a>
            </div> : <div className="reviewWorkload">
              <div className={`reviewWorkloadHero ${data.portfolio.reviewSummary.openCount ? 'hasWork' : ''}`}>
                <span>{data.portfolio.reviewSummary.openCount ? 'Needs attention' : 'All clear'}</span>
                <strong>{data.portfolio.reviewSummary.openCount}</strong>
                <small>open review{data.portfolio.reviewSummary.openCount === 1 ? '' : 's'}</small>
              </div>
              <div className="reviewWorkloadDetails">
                <div><span>Submitted amount</span><strong>{money(data.portfolio.reviewSummary.openAmount)}</strong></div>
                <div><span>Oldest open item</span><strong>{ageCopy(data.portfolio.reviewSummary.oldestCreatedAt)}</strong></div>
              </div>
              <a className="reviewQueueLink" href="/ops/reviews">Work the review queue <span>›</span></a>
            </div>}
          </DashboardCard>}

          {show('calendar') && <DashboardCard className="dashSpan12" kicker="Activity" title="Submission calendar">
            <CalendarHeatmap days={data.analytics.daily} />
          </DashboardCard>}

          {show('volume') && <DashboardCard className="dashSpan8" kicker="Portfolio activity" title="Twelve-week invoice trend">
            <div className="dashCardStatline"><strong>{money(data.portfolio.weeklyActivity.reduce((sum, point) => sum + point.amount, 0))}</strong><span>{data.portfolio.weeklyActivity.reduce((sum, point) => sum + point.count, 0)} invoices across the last twelve calendar weeks</span></div>
            <ActivityTrendChart points={data.portfolio.weeklyActivity} />
          </DashboardCard>}

          {show('top-clients') && <DashboardCard className="dashSpan4" kicker="Portfolio mix" title="Top clients by activity">
            <RankBars items={topClients.map((client) => ({ id: client.clientId, label: client.clientName, value: client.invoiceAmount, detail: `${client.invoiceCount} invoices` }))} />
          </DashboardCard>}

          {show('status') && <DashboardCard className="dashSpan4" kicker="FactorCloud status" title="Invoice status mix">
            <StatusDonut items={data.portfolio.statuses} centerValue={data.totals.invoiceCount} centerLabel="Invoices" />
          </DashboardCard>}

          {show('recent') && <DashboardCard className="dashSpan12" kicker="Recent activity" title="Latest invoices across clients">
            <div className="dashInvoiceRows">
              {data.portfolio.recentInvoices.map((invoice) => <a className="dashInvoiceRow factorInvoiceRow" href={invoice.companyClientId ? `/ops/clients/${encodeURIComponent(invoice.companyClientId)}` : '/ops'} key={invoice.id}>
                <div className="dashInvoiceGlyph">{(invoice.clientName || 'C').charAt(0).toUpperCase()}</div>
                <div className="dashInvoiceIdentity">
                  <strong>{invoice.clientName}</strong>
                  <span>Invoice {invoice.invoiceNumber || invoice.id.slice(0, 8)} · {invoice.invoiceDate || 'No date'}</span>
                </div>
                <span className={`portalStatus ${statusTone(invoice.status)}`}>{pretty(invoice.status || 'Unknown')}</span>
                <strong>{invoice.invoiceAmount == null ? '-' : money(invoice.invoiceAmount)}</strong>
              </a>)}
              {!data.portfolio.recentInvoices.length && <div className="portalEmpty"><strong>No recent activity</strong><span>Invoices will appear here as FactorCloud activity builds.</span></div>}
            </div>
          </DashboardCard>}

          {show('clients') && <section className="dashCard dashSpan12" id="clients">
            <div className="dashCardHeader clientsCardHeader">
              <div><span>Operating view</span><h2>Clients</h2><p>Search and drill into any client represented in the FactorCloud invoice data.</p></div>
              <label className="opsSearch"><span>Search</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Client name or ID" /></label>
            </div>
            <div className="batchTableWrap">
              <table className="batchTable opsTable dashboardClientTable">
                <thead><tr><th>Client</th><th>Invoices</th><th>Invoice activity</th><th>Latest activity</th><th>Status mix</th></tr></thead>
                <tbody>
                  {filtered.map((client) => <tr key={client.clientId}>
                    <td><a className="opsClientLink" href={`/ops/clients/${encodeURIComponent(client.clientId)}`}><div className="opsClientName"><strong>{client.clientName}</strong><span>{client.clientId}</span></div></a></td>
                    <td><strong>{client.invoiceCount}</strong></td>
                    <td><strong>{money(client.invoiceAmount)}</strong></td>
                    <td>{client.latestInvoiceDate || '-'}</td>
                    <td><div className="opsStatuses">{Object.entries(client.statuses).slice(0, 4).map(([status, count]) => <span key={status}>{pretty(status)} <strong>{count}</strong></span>)}</div></td>
                  </tr>)}
                  {!filtered.length && <tr><td colSpan={5}>No matching clients found.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>}
        </section>

        <p className="portalDataNote opsPortfolioNote">{data.source.note} Open A/R, aging and cash figures come from FactorCloud's balance, advance, reserve, funded and paid fields; invoices missing those fields drop out of those charts.</p>
      </>}
    </section>
  </main>;
}

function KpiRow({ kpis }: { kpis: PortfolioKpis }) {
  const dsoTrend = kpis.dsoLast90 != null && kpis.dsoPrior90 ? ((kpis.dsoLast90 - kpis.dsoPrior90) / kpis.dsoPrior90) * 100 : null;
  return <section className="dashMetricGrid factorMetricGrid">
    <DashMetric icon="A/R" label="Open A/R" value={<CountUp value={kpis.openBalance} format={compactMoney} />} detail={`${kpis.openCount} funded invoices outstanding`} />
    <DashMetric icon="↑" label="Advanced, 30 days" value={<CountUp value={kpis.fundedLast30} format={compactMoney} />} detail="Cash sent to clients" />
    <DashMetric icon="↓" label="Collected, 30 days" value={<CountUp value={kpis.collectedLast30} format={compactMoney} />} detail="Payments received from debtors" tone="good" />
    <DashMetric icon="$" label="Fees, 30 days" value={<CountUp value={kpis.feesLast30} format={compactMoney} />} detail="Earned on invoices paid" tone="good" />
    <DashMetric icon="⏱" label="Days to collect" value={kpis.dsoLast90 == null ? '-' : <CountUp value={kpis.dsoLast90} format={(v) => `${v.toFixed(1)}d`} />} detail="Last 90 days, amount-weighted" trend={dsoTrend == null ? null : -dsoTrend} tone={dsoTrend != null && dsoTrend < 0 ? 'good' : ''} />
  </section>;
}

function dsoCopy(kpis: PortfolioKpis): string {
  if (kpis.dsoLast90 == null || kpis.dsoPrior90 == null) return 'last 90 days';
  const delta = kpis.dsoLast90 - kpis.dsoPrior90;
  return `last 90 days · ${Math.abs(delta).toFixed(1)} days ${delta <= 0 ? 'faster' : 'slower'} than the prior 90`;
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

function trendCopy(value: number | null, suffix: string): string {
  if (value == null) return `No prior baseline ${suffix}`;
  if (Math.abs(value) < 0.5) return `Flat ${suffix}`;
  return `${value > 0 ? '+' : ''}${value.toFixed(0)}% ${suffix}`;
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function ageCopy(iso: string | null): string {
  if (!iso) return 'None';
  const ageMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'Just opened';
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours < 1) return '< 1 hour';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function pretty(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(status: string | null): string {
  const value = (status || '').toUpperCase();
  if (value.includes('PAID') || value.includes('FUNDED') || value.includes('PURCHASE') || value.includes('APPROV')) return 'pass';
  if (value.includes('REJECT') || value.includes('FAIL') || value.includes('ERROR')) return 'fail';
  return 'review';
}
