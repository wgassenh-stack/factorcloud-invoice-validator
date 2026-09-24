'use client';

import { useEffect, useMemo, useState } from 'react';
import { DOCUMENT_TYPE_LABELS, validate } from '@/lib/rules';
import { formatMoney, normalizeMoney } from '@/lib/normalize';
import type {
  AnalyzeResponse,
  AnalyzedDocument,
  CheckStatus,
  CreateResponse,
  DocumentType,
} from '@/lib/types';

// Vercel rejects serverless request bodies over ~4.5 MB.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

interface Status {
  factorCloud: {
    signedIn: boolean;
    source: 'session' | 'env' | null;
    canSignIn: boolean;
    factorId: boolean;
    clientId: boolean;
    debtorCount: number;
  };
  ai: boolean;
}

type EditableKey =
  | 'invoiceNumber' | 'referenceNumber' | 'debtorName' | 'debtorAddress' | 'debtorCity'
  | 'debtorState' | 'debtorZip' | 'debtorPhone' | 'invoiceDate' | 'dueDate';

const EDITABLE_FIELDS: { key: EditableKey | 'invoiceAmount'; label: string }[] = [
  { key: 'invoiceNumber', label: 'Invoice #' },
  { key: 'referenceNumber', label: 'Reference / load #' },
  { key: 'invoiceAmount', label: 'Amount' },
  { key: 'invoiceDate', label: 'Invoice date' },
  { key: 'dueDate', label: 'Due date' },
  { key: 'debtorName', label: 'Debtor' },
  { key: 'debtorAddress', label: 'Debtor street' },
  { key: 'debtorCity', label: 'Debtor city' },
  { key: 'debtorState', label: 'Debtor state' },
  { key: 'debtorZip', label: 'Debtor ZIP' },
  { key: 'debtorPhone', label: 'Debtor phone' },
];

const PLACEHOLDER_CHECKS = [
  'Debtor found in FactorCloud',
  'Company name match',
  'Address match',
  'Phone match',
  'Reference matches across documents',
  'Amount matches across documents',
];

export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [documents, setDocuments] = useState<AnalyzedDocument[]>([]);
  const [primaryIndex, setPrimaryIndex] = useState(0);
  const [amountText, setAmountText] = useState('');
  const [notes, setNotes] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateResponse | null>(null);

  const refreshStatus = () =>
    fetch('/api/status').then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
  useEffect(() => {
    refreshStatus();
  }, []);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const primary = documents[primaryIndex]?.fields;

  const report = useMemo(
    () =>
      result && documents.length
        ? validate({ documents, primaryIndex, debtor: result.debtor, client: result.client })
        : null,
    [result, documents, primaryIndex],
  );

  function addFiles(list: FileList | null) {
    // Copy now: the FileList is live and is emptied when the input is reset.
    const added = Array.from(list ?? []);
    if (!added.length) return;
    setFiles((prev) => [...prev, ...added]);
    resetResults();
  }

  function resetResults() {
    setResult(null);
    setDocuments([]);
    setCreated(null);
    setReviewed(false);
    setError('');
  }

  async function analyze() {
    setAnalyzing(true);
    resetResults();
    try {
      const form = new FormData();
      files.forEach((f) => form.append('files', f));
      const res = await fetch('/api/analyze', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Analyze failed (${res.status})`);
      const data = body as AnalyzeResponse;
      setResult(data);
      setDocuments(data.documents);
      setPrimaryIndex(data.primaryIndex);
      const amount = data.documents[data.primaryIndex]?.fields.invoiceAmount;
      setAmountText(amount === null || amount === undefined ? '' : amount.toFixed(2));
      setNotes('Created by the invoice validator.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  function updateField(key: EditableKey, value: string) {
    setDocuments((docs) =>
      docs.map((d, i) => (i === primaryIndex ? { ...d, fields: { ...d.fields, [key]: value || null } } : d)),
    );
    setReviewed(false);
  }

  function updateAmount(value: string) {
    setAmountText(value);
    setDocuments((docs) =>
      docs.map((d, i) =>
        i === primaryIndex ? { ...d, fields: { ...d.fields, invoiceAmount: normalizeMoney(value) } } : d,
      ),
    );
    setReviewed(false);
  }

  function updateType(index: number, type: DocumentType) {
    setDocuments((docs) => docs.map((d, i) => (i === index ? { ...d, fields: { ...d.fields, documentType: type } } : d)));
  }

  async function create() {
    if (!primary || !result?.debtor) return;
    setCreating(true);
    setError('');
    try {
      const form = new FormData();
      // Upload only files that were successfully analyzed, invoice first.
      const byName = new Map(files.map((f) => [f.name, f]));
      const docsWithFiles = [documents[primaryIndex], ...documents.filter((_, i) => i !== primaryIndex)].filter((d) =>
        byName.has(d.fileName),
      );
      docsWithFiles.forEach((d) => form.append('files', byName.get(d.fileName)!));
      form.append(
        'payload',
        JSON.stringify({
          invoiceNumber: primary.invoiceNumber ?? '',
          referenceNumber: primary.referenceNumber,
          invoiceAmount: primary.invoiceAmount ?? '',
          invoiceDate: primary.invoiceDate ?? '',
          notes,
          debtorId: result.debtor.id,
          documentTypes: docsWithFiles.map((d) => d.fields.documentType),
        }),
      );
      const res = await fetch('/api/create', { method: 'POST', body: form });
      const body = await res.json();
      if (body.steps) setCreated(body as CreateResponse);
      if (!res.ok) throw new Error(body.error || `Create failed (${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  const canCreate =
    !!report &&
    !!result?.debtor &&
    report.status !== 'FAIL' &&
    (report.status === 'PASS' || reviewed) &&
    !creating &&
    !created?.invoiceId;

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <span className="eyebrow">FactorCloud Labs</span>
          <h1>Invoice Intake + Validation</h1>
          <p>Upload invoice paperwork, extract key fields, validate against FactorCloud, then create the invoice without retyping it.</p>
        </div>
        <span className="prototype">Prototype</span>
      </section>

      <ConnectionBar status={status} onChange={refreshStatus} />

      {error && <div className="banner error">{error}</div>}
      {result?.warnings.map((w) => (
        <div className="banner warn" key={w}>{w}</div>
      ))}

      <section className="grid">
        <div className="card uploadCard">
          <div className="step">1</div>
          <h2>Upload documents</h2>
          <p>Add the invoice plus any BOL, POD or rate confirmation for the same load.</p>
          <label className="dropzone">
            <input
              type="file"
              multiple
              accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <strong>{files.length ? `${files.length} document${files.length > 1 ? 's' : ''} ready` : 'Drop invoice paperwork here'}</strong>
            <span>PDF or image · click to add {files.length ? 'more' : 'files'}</span>
          </label>
          {files.length > 0 && (
            <ul className="fileList">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <span>{f.name}</span>
                  <button
                    className="link"
                    onClick={() => {
                      setFiles((prev) => prev.filter((_, j) => j !== i));
                      resetResults();
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {totalBytes > MAX_UPLOAD_BYTES && (
            <p className="hint warnText">Total upload is {(totalBytes / 1024 / 1024).toFixed(1)} MB; the hosted app accepts about 4 MB per request.</p>
          )}
          <button disabled={!files.length || analyzing || totalBytes > MAX_UPLOAD_BYTES} onClick={analyze}>
            {analyzing ? 'Reading documents…' : 'Analyze documents'}
          </button>
        </div>

        <div className="card">
          <div className="step">2</div>
          <h2>Extracted invoice</h2>
          {primary ? (
            <>
              <p>Correct anything the AI misread. Validation updates as you type.</p>
              <div className="editFields">
                {EDITABLE_FIELDS.map(({ key, label }) => {
                  const uncertain = primary.uncertainFields.includes(key);
                  return (
                    <label key={key} className={uncertain ? 'uncertain' : undefined}>
                      <span>{label}{uncertain && <em> · check</em>}</span>
                      {key === 'invoiceAmount' ? (
                        <input value={amountText} inputMode="decimal" onChange={(e) => updateAmount(e.target.value)} />
                      ) : (
                        <input value={primary[key] ?? ''} onChange={(e) => updateField(key, e.target.value)} />
                      )}
                    </label>
                  );
                })}
              </div>
            </>
          ) : (
            <dl className="fields">
              {['Invoice #', 'Reference', 'Debtor', 'Amount', 'Invoice date', 'Due date'].map((l) => (
                <div key={l}><dt>{l}</dt><dd>{analyzing ? 'Reading…' : 'Waiting for document'}</dd></div>
              ))}
            </dl>
          )}
        </div>

        {documents.length > 0 && (
          <div className="card wide">
            <h2>Documents</h2>
            <p>The invoice supplies the fields above; the other documents are cross-checked against it.</p>
            <div className="tableWrap">
              <table className="docTable">
                <thead>
                  <tr><th>File</th><th>Type</th><th>Invoice #</th><th>Reference</th><th>Amount</th><th>Date</th><th>Use as invoice</th></tr>
                </thead>
                <tbody>
                  {documents.map((d, i) => (
                    <tr key={`${d.fileName}-${i}`}>
                      <td>{d.fileName}{d.fields.notes && <div className="hint">{d.fields.notes}</div>}</td>
                      <td>
                        <select value={d.fields.documentType} onChange={(e) => updateType(i, e.target.value as DocumentType)}>
                          {Object.entries(DOCUMENT_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                      <td>{d.fields.invoiceNumber ?? '—'}</td>
                      <td>{d.fields.referenceNumber ?? '—'}</td>
                      <td>{formatMoney(d.fields.invoiceAmount)}</td>
                      <td>{d.fields.invoiceDate ?? '—'}</td>
                      <td>
                        <input
                          type="radio"
                          name="primary"
                          checked={i === primaryIndex}
                          onChange={() => {
                            setPrimaryIndex(i);
                            const a = documents[i].fields.invoiceAmount;
                            setAmountText(a === null ? '' : a.toFixed(2));
                            setReviewed(false);
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="card validationCard">
          <div className="step">3</div>
          <div className="validationHeader">
            <div>
              <h2>Validation</h2>
              <p>
                {result?.debtor
                  ? `Compared against ${result.debtor.companyName} in FactorCloud (matched by ${result.debtorMatch?.method.toLowerCase()}).`
                  : 'Rules run against FactorCloud and across uploaded documents.'}
              </p>
            </div>
            <span className={`status ${report ? report.status.toLowerCase() : 'neutral'}`}>{report?.status ?? 'Not run'}</span>
          </div>
          <div className="checks">
            {report
              ? report.checks.map((c) => (
                  <div className="check" key={c.id}>
                    <div className="checkHead">
                      <span>{c.label}</span>
                      <Pill status={c.status} />
                    </div>
                    <div className="hint">{c.message}</div>
                    {c.comparisons && c.status !== 'PASS' && c.status !== 'SKIP' && (
                      <table className="compare">
                        <tbody>
                          {c.comparisons.map((cmp, i) => (
                            <tr key={i}>
                              <th>{cmp.label}</th>
                              <td>{cmp.document}</td>
                              {cmp.other !== '' && <td className="fc">{cmp.other}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ))
              : PLACEHOLDER_CHECKS.map((label) => (
                  <div className="check" key={label}>
                    <div className="checkHead"><span>{label}</span><span className="muted">Ready</span></div>
                  </div>
                ))}
          </div>
          {report && <p className="hint legend">Comparison rows show the <strong>document</strong> value, then the <strong className="fcText">FactorCloud</strong> value.</p>}
        </div>

        <div className="card actionCard">
          <div className="step">4</div>
          <h2>Create in FactorCloud</h2>
          <p>Creates the invoice, uploads every source document and attaches them. FactorCloud calculates the due date, fees and advance from the client&apos;s terms.</p>
          {report && result?.debtor && primary && (
            <dl className="fields summary">
              <div><dt>Debtor</dt><dd>{result.debtor.companyName}</dd></div>
              <div><dt>Client</dt><dd>{result.client?.companyName ?? 'Configured client'}</dd></div>
              <div><dt>Invoice # / reference</dt><dd>{primary.invoiceNumber ?? '—'} / {primary.referenceNumber ?? '—'}</dd></div>
              <div><dt>Amount / date</dt><dd>{formatMoney(primary.invoiceAmount)} · {primary.invoiceDate ?? '—'}</dd></div>
              <div><dt>Documents</dt><dd>{documents.length}</dd></div>
            </dl>
          )}
          {report && (
            <label className="notes">
              <span>Invoice notes</span>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
          )}
          {report?.status === 'REVIEW' && !created?.invoiceId && (
            <label className="confirm">
              <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
              I reviewed every REVIEW item above and want to create this invoice anyway.
            </label>
          )}
          {report?.status === 'FAIL' && <p className="hint warnText">Fix the failed checks before creating the invoice.</p>}
          <button className={canCreate ? undefined : 'secondary'} disabled={!canCreate} onClick={create}>
            {creating ? 'Creating in FactorCloud…' : created?.invoiceId ? 'Created' : 'Create invoice'}
          </button>
          {created && (
            <ul className="steps">
              {created.steps.map((s, i) => (
                <li key={i} className={s.ok ? 'ok' : 'bad'}>
                  <strong>{s.ok ? '✓' : '✕'} {s.step}</strong>
                  <span>{s.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}

function Pill({ status }: { status: CheckStatus }) {
  return <span className={`pill ${status.toLowerCase()}`}>{status}</span>;
}

function ConnectionBar({ status, onChange }: { status: Status | null; onChange: () => void }) {
  const [stage, setStage] = useState<'idle' | 'sending' | 'code' | 'verifying'>('idle');
  const [otp, setOtp] = useState('');
  const [msg, setMsg] = useState('');

  if (!status) return null;
  const fc = status.factorCloud;
  const missing: string[] = [];
  if (!status.ai) missing.push('ANTHROPIC_API_KEY');
  if (!fc.factorId) missing.push('FACTORCLOUD_FACTOR_ID');
  if (!fc.clientId) missing.push('FACTORCLOUD_CLIENT_ID');
  if (!fc.debtorCount) missing.push('FACTORCLOUD_DEBTOR_IDS');

  async function post(url: string, body?: unknown) {
    const res = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  }

  async function sendCode() {
    setStage('sending');
    setMsg('');
    try {
      await post('/api/auth/start');
      setStage('code');
      setMsg('A code was emailed to the FactorCloud user.');
    } catch (err) {
      setStage('idle');
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function verify() {
    setStage('verifying');
    try {
      await post('/api/auth/verify', { otp });
      setStage('idle');
      setOtp('');
      setMsg('');
      onChange();
    } catch (err) {
      setStage('code');
      setMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="connection">
      <div className="connItem">
        <span className={`dot ${fc.signedIn ? 'on' : 'off'}`} />
        FactorCloud: {fc.signedIn ? (fc.source === 'env' ? 'connected (server token)' : 'signed in') : 'not signed in'}
      </div>
      <div className="connItem">
        <span className={`dot ${status.ai ? 'on' : 'off'}`} />
        Document reader: {status.ai ? 'ready' : 'not configured'}
      </div>
      <div className="connActions">
        {fc.source === 'session' && (
          <button className="link" onClick={() => post('/api/auth/logout').then(onChange)}>Sign out</button>
        )}
        {fc.canSignIn && fc.source !== 'session' && stage === 'idle' && (
          <button className="small" onClick={sendCode}>{fc.signedIn ? 'Sign in as user' : 'Sign in to FactorCloud'}</button>
        )}
        {stage === 'sending' && <span className="hint">Sending code…</span>}
        {(stage === 'code' || stage === 'verifying') && (
          <span className="otp">
            <input placeholder="Emailed code" value={otp} onChange={(e) => setOtp(e.target.value)} autoFocus />
            <button className="small" disabled={!otp || stage === 'verifying'} onClick={verify}>Verify</button>
          </span>
        )}
      </div>
      {msg && <div className="connMsg">{msg}</div>}
      {missing.length > 0 && <div className="connMsg">Missing configuration: {missing.join(', ')}</div>}
    </section>
  );
}
