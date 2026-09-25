'use client';

import { useEffect, useMemo, useState } from 'react';
import { PortalNav } from '@/app/components/PortalNav';
import { validate } from '@/lib/rules';
import { applyFactorCloudAvailability } from '@/lib/validation-availability';
import type { AnalyzeResponse, CreateResponse, ExtractedFields, ValidationReport } from '@/lib/types';

type StatusResponse = {
  factorCloud: { signedIn: boolean };
  ai: { configured: boolean; model: string; thinking: string };
};

export default function SubmitInvoicePage() {
  const [files, setFiles] = useState<File[]>([]);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [originalPrimary, setOriginalPrimary] = useState<ExtractedFields | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [createResult, setCreateResult] = useState<CreateResponse | null>(null);

  useEffect(() => {
    void fetch('/api/status', { cache: 'no-store' }).then(async (res) => {
      if (res.ok) setStatus(await res.json());
    });
  }, []);

  const primary = analysis?.documents[analysis.primaryIndex];
  const clientCorrections = useMemo(() => originalPrimary && primary ? changedFields(originalPrimary, primary.fields) : [], [originalPrimary, primary]);

  const liveValidation = useMemo<ValidationReport | null>(() => {
    if (!analysis) return null;
    const base = applyFactorCloudAvailability(
      validate({ documents: analysis.documents, primaryIndex: analysis.primaryIndex, debtor: analysis.debtor, client: analysis.client }),
      analysis.factorCloudLookupFailed,
    );
    if (!clientCorrections.length || base.status === 'FAIL') return base;
    return {
      status: 'REVIEW',
      checks: [{
        id: 'client-corrections',
        label: 'Corrections after verification',
        status: 'REVIEW',
        message: `Changed field${clientCorrections.length === 1 ? '' : 's'} will be reviewed by the factor: ${clientCorrections.join(', ')}.`,
      }, ...base.checks],
    };
  }, [analysis, clientCorrections]);

  async function analyze() {
    setBusy('Analyzing documents');
    setMessage('');
    setCreateResult(null);
    try {
      const form = new FormData();
      files.forEach((f) => form.append('files', f));
      const res = await fetch('/api/analyze', { method: 'POST', body: form });
      const body = await res.json() as AnalyzeResponse & { error?: string };
      if (!res.ok) throw new Error(body.error || 'Analysis failed.');
      setAnalysis(body);
      const verifiedPrimary = body.documents[body.primaryIndex]?.fields ?? null;
      setOriginalPrimary(verifiedPrimary ? structuredClone(verifiedPrimary) : null);
      setMessage('Verification complete. Review the invoice details below.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  function updateField(docIndex: number, key: keyof ExtractedFields, value: string) {
    setAnalysis((current) => {
      if (!current) return current;
      const docs = current.documents.map((d, i) => i === docIndex ? {
        ...d,
        fields: {
          ...d.fields,
          [key]: key === 'invoiceAmount' ? (value === '' ? null : Number(value)) : (value === '' ? null : value),
        },
      } : d);
      return { ...current, documents: docs };
    });
  }

  async function submitInvoice() {
    if (!analysis || !primary || !analysis.debtor || !liveValidation || !analysis.analysisReceipt) return;
    setBusy('Submitting invoice');
    setMessage('');
    setCreateResult(null);
    try {
      const form = new FormData();
      const f = primary.fields;
      const needsReview = liveValidation.status === 'REVIEW';
      form.append('payload', JSON.stringify({
        invoiceNumber: f.invoiceNumber,
        referenceNumber: f.referenceNumber,
        invoiceAmount: f.invoiceAmount,
        invoiceDate: f.invoiceDate,
        debtorId: analysis.debtor.id,
        analysisReceipt: analysis.analysisReceipt,
      }));
      analysis.documents.forEach((d) => {
        const original = d.sourceIndex == null ? undefined : files[d.sourceIndex];
        if (original) form.append('files', original);
      });
      const res = await fetch('/api/create', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw Object.assign(new Error(body.error || 'Submission failed.'), { body });
      setCreateResult(body);
      setMessage(needsReview
        ? `Submitted for manual review. FactorCloud invoice ${body.invoiceId} was created.`
        : `Invoice submitted successfully. FactorCloud invoice ${body.invoiceId} was created.`);
    } catch (err) {
      const anyErr = err as Error & { body?: CreateResponse };
      if (anyErr.body) setCreateResult(anyErr.body);
      setMessage(anyErr.message);
    } finally {
      setBusy('');
    }
  }

  const validationClass = liveValidation?.status?.toLowerCase() ?? 'neutral';
  const attentionChecks = liveValidation?.checks.filter((c) => c.status === 'FAIL' || c.status === 'REVIEW') ?? [];
  const canSubmit = Boolean(
    analysis && analysis.analysisReceipt && !analysis.factorCloudLookupFailed && analysis.debtor && primary?.fields.invoiceNumber && primary?.fields.invoiceAmount && primary?.fields.invoiceDate && liveValidation?.status !== 'FAIL',
  );
  const submitLabel = !analysis
    ? 'Verify documents first'
    : liveValidation?.status === 'REVIEW'
      ? 'Submit for manual review'
      : liveValidation?.status === 'PASS'
        ? 'Submit invoice to FactorCloud'
        : 'Fix issues before submitting';

  return (
    <main className="shell portalToolShell">
      <PortalNav active="submit" />
      <section className="hero portalSubHero">
        <div>
          <span className="eyebrow">FactorCloud Client Portal</span>
          <h1>Submit an Invoice</h1>
          <p>Upload your invoice and freight paperwork. We will read it, verify the key details, and flag anything that needs attention before it enters FactorCloud.</p>
        </div>
        <div className="badges"><span className="prototype">Automated verification</span><span className="prototype">Secure submission</span></div>
      </section>

      <section className="topbar clientConnectionBar">
        <div><strong>FactorCloud</strong><span>{status?.factorCloud.signedIn ? 'Connected' : 'Temporarily unavailable'}</span></div>
        <div><strong>Verification</strong><span>{status?.ai.configured ? 'Ready' : 'Unavailable'}</span></div>
        {!status?.factorCloud.signedIn && <div><strong>Action</strong><span>Contact your factor if this persists</span></div>}
      </section>

      {message && <div className="message">{message}</div>}

      <section className="grid">
        <div className="card uploadCard">
          <div className="step">1</div>
          <h2>Upload documents</h2>
          <p>Invoice plus any BOL, POD, rate confirmation, or supporting paperwork.</p>
          <label className="dropzone">
            <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/gif,image/webp" onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setAnalysis(null); setOriginalPrimary(null); }} />
            <strong>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected` : 'Drop documents here'}</strong>
            <span>{files.length ? files.map((f) => f.name).join(', ') : 'PDF, PNG, JPEG, GIF, or WebP'}</span>
          </label>
          <button onClick={analyze} disabled={!files.length || Boolean(busy)}>{busy === 'Analyzing documents' ? 'Verifying...' : 'Verify documents'}</button>
        </div>

        <div className="card">
          <div className="step">2</div>
          <h2>Invoice details</h2>
          {!primary ? <p>Verify documents to extract invoice fields.</p> : <div className="editGrid">
            <Field label="Invoice #" value={primary.fields.invoiceNumber} onChange={(v) => updateField(analysis!.primaryIndex, 'invoiceNumber', v)} />
            <Field label="Reference / load #" value={primary.fields.referenceNumber} onChange={(v) => updateField(analysis!.primaryIndex, 'referenceNumber', v)} />
            <Field label="Debtor" value={primary.fields.debtorName} readOnly onChange={() => {}} />
            <Field label="Amount" type="number" value={primary.fields.invoiceAmount?.toString() ?? ''} onChange={(v) => updateField(analysis!.primaryIndex, 'invoiceAmount', v)} />
            <Field label="Invoice date" value={primary.fields.invoiceDate} onChange={(v) => updateField(analysis!.primaryIndex, 'invoiceDate', v)} />
            <Field label="Due date (source only)" value={primary.fields.dueDate} readOnly onChange={() => {}} />
            <Field label="Address" value={primary.fields.debtorAddress} readOnly onChange={() => {}} />
            <Field label="Phone" value={primary.fields.debtorPhone} readOnly onChange={() => {}} />
          </div>}
          {clientCorrections.length > 0 && <div className="warning">You changed {clientCorrections.join(', ')} after verification. The original document reading is preserved and this submission will require factor review.</div>}
          {primary && <p className="match">FactorCloud calculates the final due date from your configured terms.</p>}
          {analysis?.debtor && <p className="match">Matched debtor: <strong>{analysis.debtor.companyName}</strong>{analysis.debtorMatch ? ` via ${analysis.debtorMatch.method}` : ''}</p>}
        </div>

        <div className="card validationCard">
          <div className="step">3</div>
          <div className="validationHeader">
            <div><h2>Verification</h2><p>We compare the documents with each other and with your FactorCloud records.</p></div>
            <span className={`status ${validationClass}`}>{liveValidation?.status ?? 'Not run'}</span>
          </div>
          {analysis?.warnings.map((w) => <div className="warning" key={w}>{w}</div>)}
          {liveValidation && <div className={`attentionSummary ${validationClass}`}>
            <strong>{liveValidation.status === 'PASS' ? 'All checks clear' : `${liveValidation.status}: ${attentionChecks.length} item${attentionChecks.length === 1 ? '' : 's'} need attention`}</strong>
            {attentionChecks.map((c) => <span key={c.id}>{c.label}: {c.message}</span>)}
          </div>}
          <div className="checks">
            {liveValidation?.checks.slice().sort((a, b) => statusRank(a.status) - statusRank(b.status)).map((c) => <div className="check" key={c.id}>
              <div><strong>{c.label}</strong><span>{c.message}</span>{c.comparisons?.map((x, i) => <small key={i}>{x.label}: {x.document}{x.other ? ` | FactorCloud: ${x.other}` : ''}</small>)}</div>
              <span className={`pill ${c.status.toLowerCase()}`}>{c.status}</span>
            </div>) ?? <p>Verification appears after document analysis.</p>}
          </div>
        </div>

        {analysis && <div className="card documentsCard">
          <h2>Documents</h2>
          <div className="docList">{analysis.documents.map((d, i) => <div className="doc" key={`${d.fileName}-${i}`}>
            <strong>{d.fileName}</strong>
            <span>{d.fields.documentType.replace('_', ' ')}</span>
            <span>Reference: {d.fields.referenceNumber || '-'}</span>
            <span>Amount: {d.fields.invoiceAmount == null ? '-' : `$${d.fields.invoiceAmount.toLocaleString()}`}</span>
            {d.fields.uncertainFields.length > 0 && <em>Review: {d.fields.uncertainFields.join(', ')}</em>}
          </div>)}</div>}

        <div className="card actionCard">
          <div className="step">4</div>
          <h2>Submit to FactorCloud</h2>
          <p>{!analysis ? 'Complete verification before submitting.' : liveValidation?.status === 'REVIEW' ? 'You can submit this invoice, but it will be clearly marked for manual review.' : 'Clean submissions are created in FactorCloud with the source documents attached.'}</p>
          {analysis?.factorCloudLookupFailed && <div className="warning">FactorCloud could not be reached during analysis. Re-run verification before submitting.</div>}
          {liveValidation?.status === 'REVIEW' && !analysis?.factorCloudLookupFailed && <div className="warning">This packet has a warning. Submitting it will create the FactorCloud invoice with a clear manual-review marker in its notes.</div>}
          <button className="secondary" onClick={submitInvoice} disabled={!canSubmit || Boolean(busy)}>{busy === 'Submitting invoice' ? 'Submitting...' : submitLabel}</button>
          {createResult?.steps?.length ? <div className="steps">{createResult.steps.map((s, i) => <div key={i}><span>{s.ok ? 'OK' : 'ERROR'}</span>{s.step}: {s.detail}</div>)}</div> : null}
        </div>
      </section>
    </main>
  );
}

function statusRank(status: string): number {
  if (status === 'FAIL') return 0;
  if (status === 'REVIEW') return 1;
  if (status === 'PASS') return 2;
  return 3;
}

function changedFields(original: ExtractedFields, current: ExtractedFields): string[] {
  const changes: string[] = [];
  if ((original.invoiceNumber ?? '').trim() !== (current.invoiceNumber ?? '').trim()) changes.push('invoice number');
  if ((original.referenceNumber ?? '').trim() !== (current.referenceNumber ?? '').trim()) changes.push('reference/load number');
  if (original.invoiceAmount !== current.invoiceAmount) changes.push('invoice amount');
  if ((original.invoiceDate ?? '').trim() !== (current.invoiceDate ?? '').trim()) changes.push('invoice date');
  return changes;
}

function Field({ label, value, onChange, type = 'text', readOnly = false }: { label: string; value: string | null; onChange: (v: string) => void; type?: string; readOnly?: boolean }) {
  return <label className="field"><span>{label}</span><input type={type} value={value ?? ''} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} /></label>;
}
