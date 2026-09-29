'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { OpsSignOut } from '@/app/components/OpsSignOut';
import { ViewSwitch } from '@/app/components/ViewSwitch';

type Submission = {
  id: string;
  factorCloudInvoiceId: string | null;
  factorCloudClientId: string;
  clientName: string;
  debtorFactorCloudId: string | null;
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
  submission: Submission;
  invoice: { id: string; invoiceNumber: string | null; invoiceAmount: number | null; invoiceDate: string | null; status: string | null } | null;
  debtor: { id: string; name: string } | null;
  note: string;
  error?: string;
};

export default function OpsSubmissionDetailPage() {
  const params = useParams<{ submissionId: string }>();
  const submissionId = params.submissionId;
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deciding, setDeciding] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/ops/submissions/${encodeURIComponent(submissionId)}`, { cache: 'no-store' });
      const body = await res.json() as DetailResponse;
      if (!res.ok) throw new Error(body.error || 'Could not load submission.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [submissionId]);

  const openReview = useMemo(() => data?.submission.reviews.find((review) => review.status === 'OPEN') || null, [data]);
  const validationChecks = useMemo(() => {
    const event = data?.submission.audit.find((item) => item.eventType === 'SUBMISSION_RECEIVED');
    const payload = event?.eventData && typeof event.eventData === 'object' ? event.eventData as Record<string, unknown> : null;
    return Array.isArray(payload?.checks) ? payload.checks as Array<{ label?: string; status?: string; message?: string }> : [];
  }, [data]);

  async function decide(decision: 'APPROVE' | 'REJECT') {
    if (!openReview) return;
    const prompt = decision === 'APPROVE' ? 'Optional approval note for the audit trail:' : 'Rejection note for the audit trail:';
    const note = window.prompt(prompt, '');
    if (note === null) return;
    if (decision === 'REJECT' && !note.trim()) {
      setError('Add a short reason before rejecting a client submission.');
      return;
    }
    setDeciding(true);
    setError('');
    try {
      const res = await fetch(`/api/ops/reviews/${encodeURIComponent(openReview.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note.trim() || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save review decision.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(false);
    }
  }

  return <main className="opsShell">
    <aside className="opsSidebar">
      <a className="opsBrand" href="/ops"><img src="https://www.factorcloud.com/images/logo-nav.svg" alt="FactorCloud" /></a>
      <div className="opsRole">Factor Operations</div>
      <ViewSwitch current="staff" />
      <nav className="opsNav">
        <a href="/ops">Overview</a>
        <a href="/ops">Clients</a>
        <a href="/ops/debtors">Debtors</a>
        <a className="active" href="/ops/reviews">Review queue</a>
        <a href="/ops/funding">Funding</a>
        <a href="/ops/rules">Funding rules</a>
        <a href="/connection">Connection check</a>
      </nav>
      <div className="opsSidebarFooter"><strong>Internal view</strong><span>Factor-wide access</span><OpsSignOut /></div>
    </aside>

    <section className="opsContent">
      <a className="opsBack" href="/ops/reviews">← Review queue</a>
      {error && <div className="attentionSummary fail"><strong>Submission error</strong><span>{error}</span></div>}
      {loading && !data && <section className="opsPanel"><div className="portalEmpty"><strong>Loading submission...</strong></div></section>}

      {data && <>
        <header className="opsHeader opsSubmissionHeader">
          <div>
            <span className="eyebrow">Portal submission</span>
            <h1>{data.submission.submitted.invoiceNumber || data.submission.id.slice(0, 12)}</h1>
            <p>{data.submission.clientName} · {data.debtor?.name || 'Unknown debtor'}</p>
          </div>
          <div className="opsHeaderActions">
            <span className={`portalStatus ${tone(data.submission.workflowStatus)}`}>{pretty(data.submission.workflowStatus)}</span>
            <button className="small opsRefresh" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
          </div>
        </header>

        {openReview && <section className="opsDecisionBanner">
          <div><strong>Factor decision required</strong><span>{openReview.reason}</span></div>
          <div className="opsDecisionButtons"><button disabled={deciding} onClick={() => void decide('APPROVE')}>{deciding ? 'Saving...' : 'Approve'}</button><button className="opsRejectButton" disabled={deciding} onClick={() => void decide('REJECT')}>Reject</button></div>
        </section>}

        <section className="opsMetrics">
          <Metric label="Amount" value={moneyMaybe(data.submission.submitted.invoiceAmount) || '-'} />
          <Metric label="Validation" value={pretty(data.submission.validationStatus)} />
          <Metric label="FactorCloud status" value={data.invoice ? pretty(data.invoice.status || 'Unknown') : 'Unavailable'} />
          <Metric label="Submitted" value={dateTime(data.submission.createdAt)} />
        </section>

        <div className="warning opsDataNote">{data.note}</div>

        <section className="opsClientGrid">
          <div className="opsPanel">
            <div className="opsPanelHeader"><div><h2>Verified vs submitted</h2><p>Any client correction is visible rather than replacing the original evidence.</p></div></div>
            <div className="opsDetailComparison">
              <Comparison label="Invoice #" original={data.submission.original.invoiceNumber} submitted={data.submission.submitted.invoiceNumber} />
              <Comparison label="Reference / load" original={data.submission.original.referenceNumber} submitted={data.submission.submitted.referenceNumber} />
              <Comparison label="Amount" original={moneyMaybe(data.submission.original.invoiceAmount)} submitted={moneyMaybe(data.submission.submitted.invoiceAmount)} />
              <Comparison label="Invoice date" original={data.submission.original.invoiceDate} submitted={data.submission.submitted.invoiceDate} />
            </div>
          </div>

          <div className="opsPanel">
            <div className="opsPanelHeader"><div><h2>Submission identity</h2><p>Who sent it and where it landed.</p></div></div>
            <div className="opsDetailFacts">
              <Fact label="Submitted by" value={data.submission.submittedBy.name || data.submission.submittedBy.email || '-'} />
              <Fact label="Client" value={data.submission.clientName} />
              <Fact label="Portal submission ID" value={data.submission.id} mono />
              <Fact label="FactorCloud invoice ID" value={data.submission.factorCloudInvoiceId || '-'} mono />
            </div>
          </div>
        </section>

        {validationChecks.length > 0 && <section className="opsPanel opsDetailSection">
          <div className="opsPanelHeader"><div><h2>Validation checks</h2><p>Exact rule results recorded at submission.</p></div></div>
          <div className="opsValidationList">
            {validationChecks.map((check, index) => <div key={`${check.label}-${index}`}><span className={`portalStatus ${tone(check.status || '')}`}>{pretty(check.status || 'Unknown')}</span><div><strong>{check.label || 'Check'}</strong><p>{check.message || '-'}</p></div></div>)}
          </div>
        </section>}

        <section className="opsPanel opsDetailSection">
          <div className="opsPanelHeader"><div><h2>Documents</h2><p>File fingerprints recorded when the packet was analyzed.</p></div></div>
          <div className="opsDocumentList">
            {data.submission.files.map((file) => <div key={file.id}><div><strong>{file.fileName}</strong><span>{pretty(file.documentType || 'document')} · {fileSize(file.fileSizeBytes)}</span></div><code>{file.sha256}</code></div>)}
          </div>
        </section>

        <section className="opsClientGrid opsDetailSection">
          <div className="opsPanel">
            <div className="opsPanelHeader"><div><h2>Review history</h2><p>Factor decisions for this submission.</p></div></div>
            <div className="opsTimeline">
              {data.submission.reviews.map((review) => <div key={review.id}><span className={`timelineDot ${tone(review.status)}`} /><div><strong>{pretty(review.status)}</strong><p>{review.reason}</p>{review.decisionNote && <p>Decision note: {review.decisionNote}</p>}<small>{review.decidedAt ? `${dateTime(review.decidedAt)} · ${review.decidedBy.name || review.decidedBy.email || 'Factor staff'}` : `Opened ${dateTime(review.createdAt)}`}</small></div></div>)}
              {!data.submission.reviews.length && <div className="portalEmpty compact"><strong>No manual review</strong></div>}
            </div>
          </div>

          <div className="opsPanel">
            <div className="opsPanelHeader"><div><h2>Audit history</h2><p>Who did what and when.</p></div></div>
            <div className="opsTimeline">
              {data.submission.audit.map((event) => <div key={event.id}><span className="timelineDot review" /><div><strong>{pretty(event.eventType)}</strong><small>{dateTime(event.createdAt)} · {event.actor.name || event.actor.email || 'System'}</small></div></div>)}
            </div>
          </div>
        </section>
      </>}
    </section>
  </main>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="opsMetric"><span>{label}</span><strong>{value}</strong></div>; }
function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div><span>{label}</span><strong className={mono ? 'opsMono' : ''}>{value}</strong></div>; }
function Comparison({ label, original, submitted }: { label: string; original: string | null; submitted: string | null }) { const changed = (original || '') !== (submitted || ''); return <div className={changed ? 'changed' : ''}><span>{label}</span><div><small>Document</small><strong>{original || '-'}</strong></div><div><small>Submitted</small><strong>{submitted || '-'}</strong></div>{changed && <b>Changed</b>}</div>; }
function pretty(value: string): string { return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function dateTime(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : value; }
function moneyMaybe(value: number | null): string | null { return value == null ? null : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value); }
function fileSize(value: number | null): string { if (value == null) return 'Size unavailable'; if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`; return `${(value / (1024 * 1024)).toFixed(1)} MB`; }
function tone(status: string): string { const value = status.toUpperCase(); if (value.includes('PASS') || value.includes('APPROV') || value.includes('CREATED')) return 'pass'; if (value.includes('FAIL') || value.includes('REJECT') || value.includes('ERROR')) return 'fail'; return 'review'; }
