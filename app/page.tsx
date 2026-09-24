'use client';

import { useEffect, useMemo, useState } from 'react';
import { validate } from '@/lib/rules';
import { applyFactorCloudAvailability } from '@/lib/validation-availability';
import type { AnalyzeResponse, CreateResponse, ExtractedFields } from '@/lib/types';

type StatusResponse = {
  factorCloud: { signedIn: boolean; canSignIn: boolean };
  ai: { configured: boolean; model: string; thinking: string };
};

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [otp, setOtp] = useState('');
  const [otpRequested, setOtpRequested] = useState(false);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [createResult, setCreateResult] = useState<CreateResponse | null>(null);

  const refreshStatus = async () => {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (res.ok) setStatus(await res.json());
  };
  useEffect(() => { void refreshStatus(); }, []);

  const liveValidation = useMemo(() => {
    if (!analysis) return null;
    return applyFactorCloudAvailability(
      validate({ documents: analysis.documents, primaryIndex: analysis.primaryIndex, debtor: analysis.debtor, client: analysis.client }),
      analysis.factorCloudLookupFailed,
    );
  }, [analysis]);

  const primary = analysis?.documents[analysis.primaryIndex];

  async function analyze() {
    setBusy('Analyzing documents'); setMessage(''); setCreateResult(null);
    try {
      const form = new FormData();
      files.forEach((f) => form.append('files', f));
      const res = await fetch('/api/analyze', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Analysis failed.');
      setAnalysis(body);
      setOverride(false);
      setOverrideReason('');
      setMessage('Analysis complete. Review the extracted values before creating anything.');
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(''); }
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

  async function requestOtp() {
    setBusy('Requesting FactorCloud code'); setMessage('');
    try {
      const res = await fetch('/api/auth/start', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not start sign-in.');
      setOtpRequested(true);
      setMessage('FactorCloud sent an email code. Enter it below.');
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(''); }
  }

  async function verifyOtp() {
    setBusy('Signing in'); setMessage('');
    try {
      const res = await fetch('/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ otp }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Sign-in failed.');
      setOtpRequested(false); setOtp(''); await refreshStatus();
      setMessage('Signed in to FactorCloud. Re-run Analyze so the FactorCloud comparisons refresh.');
    } catch (err) { setMessage(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(''); }
  }

  async function createInvoice() {
    if (!analysis || !primary || !analysis.debtor) return;
    const v = liveValidation;
    if (!v) return;
    setBusy('Creating invoice'); setMessage(''); setCreateResult(null);
    try {
      const form = new FormData();
      const f = primary.fields;
      const payload = {
        invoiceNumber: f.invoiceNumber,
        referenceNumber: f.referenceNumber,
        invoiceAmount: f.invoiceAmount,
        invoiceDate: f.invoiceDate,
        notes: 'Created through external validator prototype',
        debtorId: analysis.debtor.id,
        primaryIndex: analysis.primaryIndex,
        documents: analysis.documents,
        documentTypes: analysis.documents.map((d) => d.fields.documentType),
        overrideReview: override,
        overrideReason,
      };
      form.append('payload', JSON.stringify(payload));
      analysis.documents.forEach((d) => {
        const original = files.find((x) => x.name === d.fileName);
        if (original) form.append('files', original);
      });
      const res = await fetch('/api/create', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw Object.assign(new Error(body.error || 'Create failed.'), { body });
      setCreateResult(body);
      setMessage(`Created FactorCloud invoice ${body.invoiceId}.`);
    } catch (err) {
      const anyErr = err as Error & { body?: CreateResponse };
      if (anyErr.body) setCreateResult(anyErr.body);
      setMessage(anyErr.message);
    } finally { setBusy(''); }
  }

  const validationClass = liveValidation?.status?.toLowerCase() ?? 'neutral';
  const attentionChecks = liveValidation?.checks.filter((c) => c.status === 'FAIL' || c.status === 'REVIEW') ?? [];
  const canCreate = Boolean(
    analysis &&
    !analysis.factorCloudLookupFailed &&
    analysis.debtor &&
    primary?.fields.invoiceNumber &&
    primary?.fields.invoiceAmount &&
    primary?.fields.invoiceDate &&
    liveValidation?.status !== 'FAIL',
  );

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <span className="eyebrow">FactorCloud Labs</span>
          <h1>Invoice Intake + Validation</h1>
          <p>Read freight paperwork, compare it against FactorCloud, and create the invoice without retyping it.</p>
        </div>
        <div className="badges">
          <span className="prototype activeMode">Single packet</span>
          <a className="modeLink" href="/batch">Batch intake</a>
          <span className="prototype">{status?.ai.model ?? 'checking AI...'}</span>
        </div>
      </section>

      <section className="topbar">
        <div><strong>AI</strong><span>{status?.ai.configured ? `${status.ai.model} (${status.ai.thinking})` : 'Not configured'}</span></div>
        <div><strong>FactorCloud</strong><span>{status?.factorCloud.signedIn ? 'Connected' : 'Not signed in'}</span></div>
        {!status?.factorCloud.signedIn && status?.factorCloud.canSignIn && <button className="small" onClick={requestOtp} disabled={Boolean(busy)}>Email login code</button>}
        {otpRequested && <div className="otp"><input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="OTP code"/><button className="small" onClick={verifyOtp} disabled={!otp || Boolean(busy)}>Sign in</button></div>}
      </section>

      {message && <div className="message">{message}</div>}

      <section className="grid">
        <div className="card uploadCard">
          <div className="step">1</div>
          <h2>Upload documents</h2>
          <p>Invoice plus any BOL, POD, rate confirmation, or supporting paperwork.</p>
          <label className="dropzone">
            <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/gif,image/webp" onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setAnalysis(null); }} />
            <strong>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} selected` : 'Drop documents here'}</strong>
            <span>{files.length ? files.map((f) => f.name).join(', ') : 'PDF, PNG, JPEG, GIF, or WebP'}</span>
          </label>
          <button onClick={analyze} disabled={!files.length || Boolean(busy)}>{busy === 'Analyzing documents' ? 'Analyzing...' : 'Analyze documents'}</button>
        </div>

        <div className="card">
          <div className="step">2</div>
          <h2>Primary invoice</h2>
          {!primary ? <p>Analyze documents to extract invoice fields.</p> : <div className="editGrid">
            <Field label="Invoice #" value={primary.fields.invoiceNumber} onChange={(v) => updateField(analysis!.primaryIndex, 'invoiceNumber', v)} />
            <Field label="Reference / load #" value={primary.fields.referenceNumber} onChange={(v) => updateField(analysis!.primaryIndex, 'referenceNumber', v)} />
            <Field label="Debtor" value={primary.fields.debtorName} onChange={(v) => updateField(analysis!.primaryIndex, 'debtorName', v)} />
            <Field label="Amount" type="number" value={primary.fields.invoiceAmount?.toString() ?? ''} onChange={(v) => updateField(analysis!.primaryIndex, 'invoiceAmount', v)} />
            <Field label="Invoice date" value={primary.fields.invoiceDate} onChange={(v) => updateField(analysis!.primaryIndex, 'invoiceDate', v)} />
            <Field label="Due date (source only)" value={primary.fields.dueDate} readOnly onChange={() => {}} />
            <Field label="Address" value={primary.fields.debtorAddress} onChange={(v) => updateField(analysis!.primaryIndex, 'debtorAddress', v)} />
            <Field label="Phone" value={primary.fields.debtorPhone} onChange={(v) => updateField(analysis!.primaryIndex, 'debtorPhone', v)} />
          </div>}
          {primary && <p className="match">FactorCloud calculates the final due date from the client's configured terms when the invoice is created.</p>}
          {analysis?.debtor && <p className="match">Matched FactorCloud debtor: <strong>{analysis.debtor.companyName}</strong>{analysis.debtorMatch ? ` via ${analysis.debtorMatch.method}` : ''}</p>}
        </div>

        <div className="card validationCard">
          <div className="step">3</div>
          <div className="validationHeader">
            <div><h2>Validation</h2><p>AI extracts. Deterministic rules decide.</p></div>
            <span className={`status ${validationClass}`}>{liveValidation?.status ?? 'Not run'}</span>
          </div>
          {analysis?.warnings.map((w) => <div className="warning" key={w}>{w}</div>)}
          {liveValidation && <div className={`attentionSummary ${validationClass}`}>
            <strong>{liveValidation.status === 'PASS' ? 'PASS: no validation issues found' : `${liveValidation.status}: ${attentionChecks.length} item${attentionChecks.length === 1 ? '' : 's'} need attention`}</strong>
            {attentionChecks.map((c) => <span key={c.id}>{c.label}: {c.message}</span>)}
          </div>}
          <div className="checks">
            {liveValidation?.checks.slice().sort((a, b) => statusRank(a.status) - statusRank(b.status)).map((c) => <div className="check" key={c.id}>
              <div><strong>{c.label}</strong><span>{c.message}</span>{c.comparisons?.map((x, i) => <small key={i}>{x.label}: {x.document}{x.other ? ` | FactorCloud: ${x.other}` : ''}</small>)}</div>
              <span className={`pill ${c.status.toLowerCase()}`}>{c.status}</span>
            </div>) ?? <p>Validation appears after analysis.</p>}
          </div>
        </div>

        {analysis && <div className="card documentsCard">
          <h2>All extracted documents</h2>
          <div className="docList">{analysis.documents.map((d, i) => <div className="doc" key={`${d.fileName}-${i}`}>
            <strong>{d.fileName}</strong>
            <span>{d.fields.documentType.replace('_', ' ')}</span>
            <span>Reference: {d.fields.referenceNumber || '-'}</span>
            <span>Amount: {d.fields.invoiceAmount == null ? '-' : `$${d.fields.invoiceAmount.toLocaleString()}`}</span>
            {d.usage && <span className="usage">AI: {d.usage.model} · {d.usage.totalTokens.toLocaleString()} tokens{d.usage.estimatedCostUsd != null ? ` · ~$${d.usage.estimatedCostUsd.toFixed(4)}` : ''}</span>}
            {d.fields.uncertainFields.length > 0 && <em>Review: {d.fields.uncertainFields.join(', ')}</em>}
          </div>)}</div>
        </div>}

        <div className="card actionCard">
          <div className="step">4</div>
          <h2>Create in FactorCloud</h2>
          <p>The server re-runs validation and performs a duplicate check before creating anything.</p>
          {analysis?.factorCloudLookupFailed && <div className="warning">FactorCloud could not be reached during analysis. Re-run Analyze before creating this invoice.</div>}
          {liveValidation?.status === 'REVIEW' && !analysis?.factorCloudLookupFailed && <div className="overrideBox"><label><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> I reviewed the warnings and want to continue.</label>{override && <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why is this safe to create?" />}</div>}
          <button className="secondary" onClick={createInvoice} disabled={!canCreate || Boolean(busy) || (liveValidation?.status === 'REVIEW' && !analysis?.factorCloudLookupFailed && (!override || !overrideReason.trim()))}>{busy === 'Creating invoice' ? 'Creating...' : 'Create invoice'}</button>
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

function Field({ label, value, onChange, type = 'text', readOnly = false }: { label: string; value: string | null; onChange: (v: string) => void; type?: string; readOnly?: boolean }) {
  return <label className="field"><span>{label}</span><input type={type} value={value ?? ''} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} /></label>;
}
