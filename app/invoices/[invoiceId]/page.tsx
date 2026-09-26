'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { PortalNav } from '@/app/components/PortalNav';
import { InvoiceTracker, Skeleton } from '@/app/components/CommandCharts';
import { DemoBadge } from '@/app/components/DemoBadge';
import { lifecycleStage } from '@/lib/analytics';
import type { RiskInvoiceRecord } from '@/lib/risk';

type InvoiceRecord = RiskInvoiceRecord;

type PortalWorkflow = {
  id: string;
  factorCloudInvoiceId: string | null;
  validationStatus: string;
  workflowStatus: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: { email: string | null; name: string | null };
  original: { invoiceNumber: string | null; referenceNumber: string | null; invoiceAmount: number | null; invoiceDate: string | null };
  submitted: { invoiceNumber: string | null; referenceNumber: string | null; invoiceAmount: number | null; invoiceDate: string | null };
  files: Array<{ id: string; fileName: string; sourceIndex: number; sha256: string; documentType: string | null; fileSizeBytes: number | null; createdAt: string }>;
  reviews: Array<{ id: string; status: string; reason: string; decisionNote: string | null; createdAt: string; decidedAt: string | null; decidedBy: { email: string | null; name: string | null } }>;
  audit: Array<{ id: string; eventType: string; eventData: unknown; createdAt: string; actor: { email: string | null; name: string | null } }>;
};

type DetailResponse = {
  invoice: InvoiceRecord;
  debtor: { id: string; name: string; code: string | null; phone: string | null } | null;
  workflow: PortalWorkflow | null;
  source: { note: string };
  error?: string;
};

export default function InvoiceDetailPage() {
  const params = useParams<{ invoiceId: string }>();
  const invoiceId = params.invoiceId;
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}`, { cache: 'no-store' });
      const body = await res.json() as DetailResponse;
      if (!res.ok) throw new Error(body.error || 'Could not load invoice detail.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [invoiceId]);

  const validationChecks = useMemo(() => {
    const event = data?.workflow?.audit.find((item) => item.eventType === 'SUBMISSION_RECEIVED');
    const payload = event?.eventData && typeof event.eventData === 'object' ? event.eventData as Record<string, unknown> : null;
    return Array.isArray(payload?.checks) ? payload.checks as Array<{ label?: string; status?: string; message?: string }> : [];
  }, [data]);

  return <main className="portalShell">
    <PortalNav active="invoices" />
    <a className="portalBackLink" href="/invoices">← Back to invoices</a>

    {error && <div className="attentionSummary fail"><strong>Could not load invoice</strong><span>{error}</span></div>}
    {loading && !data && <section className="portalPanel invoiceDetailLoading"><Skeleton height={90} lines={3} /></section>}

    {data && <>
      <section className="invoiceDetailHero">
        <div>
          <div className="dashboardHeroMeta"><span className="eyebrow">Invoice detail</span><DemoBadge /></div>
          <h1>{data.invoice.invoiceNumber || data.invoice.id.slice(0, 8)}</h1>
          <p>{data.debtor?.name || 'FactorCloud debtor'} · FactorCloud ID {data.invoice.id}</p>
        </div>
        <div className="invoiceDetailHeroStatus">
          <span className={`portalStatus ${statusTone(data.invoice.status)}`}>{pretty(data.invoice.status || 'Unknown')}</span>
          <button className="small invoiceRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
        </div>
      </section>

      <section className="portalPanel invoiceTrackerPanel">
        <InvoiceTracker stage={lifecycleStage(data.invoice)} dates={{ SUBMITTED: data.invoice.createdOn || data.invoice.invoiceDate, VERIFIED: null, FUNDED: data.invoice.fundedDate ?? null, PAID: data.invoice.paidDate ?? null }} />
        {data.invoice.advanceAmount ? <MoneyBreakdown invoice={data.invoice} /> : null}
      </section>

      <section className="invoiceDetailMetrics">
        <Metric label="Amount" value={data.invoice.invoiceAmount == null ? '-' : money(data.invoice.invoiceAmount)} />
        <Metric label="Invoice date" value={data.invoice.invoiceDate || '-'} />
        <Metric label="Debtor" value={data.debtor?.name || '-'} />
        <Metric label="Portal workflow" value={data.workflow ? pretty(data.workflow.workflowStatus) : 'Not submitted here'} />
      </section>

      {data.workflow ? <>
        <section className="invoiceDetailGrid">
          <div className="portalPanel detailCard">
            <div className="portalPanelHeader"><div><span className="panelKicker">Portal workflow</span><h2>Submission</h2></div><span className={`portalStatus ${statusTone(data.workflow.validationStatus)}`}>{pretty(data.workflow.validationStatus)}</span></div>
            <div className="detailFacts">
              <Fact label="Submitted by" value={data.workflow.submittedBy.name || data.workflow.submittedBy.email || '-'} />
              <Fact label="Submitted" value={dateTime(data.workflow.createdAt)} />
              <Fact label="Last updated" value={dateTime(data.workflow.updatedAt)} />
              <Fact label="Workflow status" value={pretty(data.workflow.workflowStatus)} />
            </div>
          </div>

          <div className="portalPanel detailCard">
            <div className="portalPanelHeader"><div><span className="panelKicker">Verified paperwork</span><h2>Submitted fields</h2></div></div>
            <div className="detailComparison">
              <Comparison label="Invoice #" original={data.workflow.original.invoiceNumber} submitted={data.workflow.submitted.invoiceNumber} />
              <Comparison label="Reference / load" original={data.workflow.original.referenceNumber} submitted={data.workflow.submitted.referenceNumber} />
              <Comparison label="Amount" original={moneyMaybe(data.workflow.original.invoiceAmount)} submitted={moneyMaybe(data.workflow.submitted.invoiceAmount)} />
              <Comparison label="Invoice date" original={data.workflow.original.invoiceDate} submitted={data.workflow.submitted.invoiceDate} />
            </div>
          </div>
        </section>

        {validationChecks.length > 0 && <section className="portalPanel invoiceDetailSection">
          <div className="portalPanelHeader"><div><span className="panelKicker">Validation</span><h2>Checks run at submission</h2><p>The result recorded when this paperwork entered the portal.</p></div></div>
          <div className="detailCheckList">
            {validationChecks.map((check, index) => <div className="detailCheck" key={`${check.label}-${index}`}><span className={`portalStatus ${statusTone(check.status || '')}`}>{pretty(check.status || 'Unknown')}</span><div><strong>{check.label || 'Check'}</strong><p>{check.message || '-'}</p></div></div>)}
          </div>
        </section>}

        <section className="portalPanel invoiceDetailSection">
          <div className="portalPanelHeader"><div><span className="panelKicker">Documents</span><h2>Submitted files</h2><p>These fingerprints tie the stored workflow record to the exact files that were verified.</p></div></div>
          <div className="detailFileList">
            {data.workflow.files.map((file) => <div className="detailFile" key={file.id}><div><strong>{file.fileName}</strong><span>{pretty(file.documentType || 'document')} · {fileSize(file.fileSizeBytes)}</span></div><code>{file.sha256.slice(0, 16)}…</code></div>)}
          </div>
        </section>

        <section className="invoiceDetailGrid invoiceDetailSection">
          <div className="portalPanel detailCard">
            <div className="portalPanelHeader"><div><span className="panelKicker">Factor review</span><h2>Review history</h2></div></div>
            <div className="detailTimeline">
              {data.workflow.reviews.map((review) => <div className="timelineItem" key={review.id}><span className={`timelineDot ${statusTone(review.status)}`} /><div><strong>{pretty(review.status)}</strong><p>{review.reason}</p>{review.decisionNote && <p>Decision note: {review.decisionNote}</p>}<small>{review.decidedAt ? `Decided ${dateTime(review.decidedAt)} by ${review.decidedBy.name || review.decidedBy.email || 'factor staff'}` : `Opened ${dateTime(review.createdAt)}`}</small></div></div>)}
              {!data.workflow.reviews.length && <div className="portalEmpty compact"><strong>No manual review required</strong><span>This submission did not create a review item.</span></div>}
            </div>
          </div>

          <div className="portalPanel detailCard">
            <div className="portalPanelHeader"><div><span className="panelKicker">Audit trail</span><h2>Activity</h2></div></div>
            <div className="detailTimeline">
              {data.workflow.audit.map((event) => <div className="timelineItem" key={event.id}><span className="timelineDot review" /><div><strong>{pretty(event.eventType)}</strong><small>{dateTime(event.createdAt)} · {event.actor.name || event.actor.email || 'System'}</small></div></div>)}
            </div>
          </div>
        </section>
      </> : <section className="portalPanel invoiceDetailSection"><div className="portalEmpty"><strong>No portal workflow record</strong><span>This invoice may predate the portal or may have been created directly in FactorCloud. Its current FactorCloud status is still shown above.</span></div></section>}

      <p className="portalDataNote">{data.source.note}</p>
    </>}
  </main>;
}

function MoneyBreakdown({ invoice }: { invoice: InvoiceRecord }) {
  const amount = invoice.invoiceAmount ?? 0;
  const advance = invoice.advanceAmount ?? 0;
  const fee = invoice.purchaseFeeAmount ?? 0;
  const reserve = Math.max(0, (invoice.escrowReserveAmount ?? amount - advance) - fee);
  const parts = [
    { label: 'Advanced to you', value: advance, color: '#2a78d6' },
    { label: invoice.paidDate ? 'Reserve released' : 'Reserve (paid when debtor pays)', value: reserve, color: '#86b6ef' },
    { label: 'Factoring fee', value: fee, color: '#c3c2b7' },
  ];
  return <div className="moneySplit">
    <div className="moneySplitBar">{parts.map((part) => part.value > 0 && <span key={part.label} style={{ flexGrow: part.value, background: part.color }} title={`${part.label}: ${money(part.value)}`} />)}</div>
    <div className="moneySplitLegend">{parts.map((part) => <div key={part.label}><i style={{ background: part.color }} /><span>{part.label}</span><strong>{money(part.value)}</strong></div>)}</div>
    {invoice.invoiceBalance != null && !invoice.paidDate && <small>{money(invoice.invoiceBalance)} still owed by the debtor{invoice.dueDate ? ` · due ${invoice.dueDate}` : ''}</small>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="portalMetric"><span>{label}</span><strong>{value}</strong></div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function Comparison({ label, original, submitted }: { label: string; original: string | null; submitted: string | null }) {
  const changed = (original || '') !== (submitted || '');
  return <div className={changed ? 'changed' : ''}><span>{label}</span><div><small>Document</small><strong>{original || '-'}</strong></div><div><small>Submitted</small><strong>{submitted || '-'}</strong></div>{changed && <b>Changed</b>}</div>;
}
function money(value: number): string { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value); }
function moneyMaybe(value: number | null): string | null { return value == null ? null : money(value); }
function pretty(value: string): string { return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function dateTime(value: string): string { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString() : value; }
function fileSize(value: number | null): string { if (value == null) return 'Size unavailable'; if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
function statusTone(status: string | null): string {
  const value = (status || '').toUpperCase();
  if (value.includes('PASS') || value.includes('APPROV') || value.includes('PAID') || value.includes('FUNDED') || value.includes('CREATED')) return 'pass';
  if (value.includes('FAIL') || value.includes('REJECT') || value.includes('ERROR')) return 'fail';
  return 'review';
}
