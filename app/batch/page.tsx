'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BatchAnalyzeResponse, BatchPacketAnalysis, CreateResponse } from '@/lib/types';

type StatusResponse = {
  factorCloud: { signedIn: boolean; canSignIn: boolean };
  ai: { configured: boolean; model: string; thinking: string };
};

type RowResult = { state: 'creating' | 'created' | 'error'; message: string; invoiceId?: string };

export default function BatchPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [analysis, setAnalysis] = useState<BatchAnalyzeResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [results, setResults] = useState<Record<string, RowResult>>({});

  useEffect(() => {
    void fetch('/api/status', { cache: 'no-store' }).then(async (res) => {
      if (res.ok) setStatus(await res.json());
    });
  }, []);

  const counts = useMemo(() => {
    const packets = analysis?.packets ?? [];
    return {
      pass: packets.filter((p) => p.validation.status === 'PASS').length,
      review: packets.filter((p) => p.validation.status === 'REVIEW').length,
      fail: packets.filter((p) => p.validation.status === 'FAIL').length,
    };
  }, [analysis]);

  const estimatedCost = useMemo(() =>
    (analysis?.packets ?? []).reduce((packetSum, packet) => packetSum + packet.documents.reduce((docSum, doc) => docSum + (doc.usage?.estimatedCostUsd ?? 0), 0), 0)
    + (analysis?.unassignedDocuments ?? []).reduce((sum, doc) => sum + (doc.usage?.estimatedCostUsd ?? 0), 0),
  [analysis]);

  async function analyzeBatch() {
    setBusy('Analyzing batch');
    setMessage('');
    setResults({});
    try {
      const form = new FormData();
      files.forEach((file) => form.append('files', file));
      const res = await fetch('/api/analyze-batch', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Batch analysis failed.');
      setAnalysis(body);
      setMessage(`Grouped ${body.packets.length} invoice packet${body.packets.length === 1 ? '' : 's'} from ${files.length} uploaded documents.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  }

  async function createOne(packet: BatchPacketAnalysis): Promise<boolean> {
    const key = packet.packetId;
    if (packet.validation.status !== 'PASS' || !packet.debtor || packet.factorCloudLookupFailed) return false;
    setResults((current) => ({ ...current, [key]: { state: 'creating', message: 'Creating...' } }));
    try {
      const primary = packet.documents[packet.primaryIndex];
      const f = primary.fields;
      const form = new FormData();
      form.append('payload', JSON.stringify({
        invoiceNumber: f.invoiceNumber,
        referenceNumber: f.referenceNumber,
        invoiceAmount: f.invoiceAmount,
        invoiceDate: f.invoiceDate,
        notes: 'Created through external validator batch intake',
        debtorId: packet.debtor.id,
        primaryIndex: packet.primaryIndex,
        documents: packet.documents,
        documentTypes: packet.documents.map((d) => d.fields.documentType),
        overrideReview: false,
        overrideReason: null,
      }));
      for (const doc of packet.documents) {
        const original = files.find((file) => file.name === doc.fileName);
        if (original) form.append('files', original);
      }
      const res = await fetch('/api/create', { method: 'POST', body: form });
      const body = await res.json() as CreateResponse;
      if (!res.ok) throw new Error(body.error || 'Create failed.');
      setResults((current) => ({ ...current, [key]: { state: 'created', message: `Created ${body.invoiceId}`, invoiceId: body.invoiceId ?? undefined } }));
      return true;
    } catch (err) {
      setResults((current) => ({ ...current, [key]: { state: 'error', message: err instanceof Error ? err.message : String(err) } }));
      return false;
    }
  }

  async function createAllPass() {
    if (!analysis) return;
    const packets = analysis.packets.filter((p) => p.validation.status === 'PASS' && p.debtor && !p.factorCloudLookupFailed && results[p.packetId]?.state !== 'created');
    setBusy('Creating PASS invoices');
    let created = 0;
    for (const packet of packets) {
      if (await createOne(packet)) created += 1;
    }
    setBusy('');
    setMessage(`Batch create finished. ${created} of ${packets.length} eligible invoice${packets.length === 1 ? '' : 's'} created.`);
  }

  const eligiblePass = analysis?.packets.filter((p) => p.validation.status === 'PASS' && p.debtor && !p.factorCloudLookupFailed && results[p.packetId]?.state !== 'created').length ?? 0;

  return (
    <main className="shell batchShell">
      <section className="hero">
        <div>
          <span className="eyebrow">FactorCloud Labs</span>
          <h1>Batch Invoice Intake</h1>
          <p>Drop a mixed stack of invoices and supporting documents. The app groups them into invoice packets, validates each packet, and can create every clean invoice in one run.</p>
        </div>
        <div className="badges">
          <a className="modeLink" href="/">Single packet</a>
          <span className="prototype activeMode">Batch intake</span>
        </div>
      </section>

      <section className="topbar">
        <div><strong>AI</strong><span>{status?.ai.configured ? `${status.ai.model} (${status.ai.thinking})` : 'Not configured'}</span></div>
        <div><strong>FactorCloud</strong><span>{status?.factorCloud.signedIn ? 'Connected' : 'Not signed in'}</span></div>
        <div><strong>Pilot limit</strong><span>24 files / 25 MB per batch</span></div>
      </section>

      {message && <div className="message">{message}</div>}

      <section className="card batchUpload">
        <h2>Upload a mixed document batch</h2>
        <p>You can include multiple invoices plus rate confirmations, BOLs, PODs, and other support files. Exact shared load/reference numbers are the strongest grouping signal.</p>
        <label className="dropzone batchDropzone">
          <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/gif,image/webp" onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setAnalysis(null); setResults({}); }} />
          <strong>{files.length ? `${files.length} files selected` : 'Drop the whole batch here'}</strong>
          <span>{files.length ? files.map((f) => f.name).join(', ') : 'PDF, PNG, JPEG, GIF, or WebP'}</span>
        </label>
        <button onClick={analyzeBatch} disabled={!files.length || Boolean(busy)}>{busy === 'Analyzing batch' ? 'Analyzing and grouping...' : 'Analyze batch'}</button>
      </section>

      {analysis && <>
        <section className="batchStats">
          <Stat label="Invoice packets" value={analysis.packets.length} />
          <Stat label="PASS" value={counts.pass} tone="pass" />
          <Stat label="REVIEW" value={counts.review} tone="review" />
          <Stat label="FAIL" value={counts.fail} tone="fail" />
          <Stat label="Unassigned docs" value={analysis.unassignedDocuments.length} />
          <Stat label="Est. AI cost" value={`$${estimatedCost.toFixed(4)}`} />
        </section>

        {analysis.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}

        <section className="card batchTableCard">
          <div className="batchTableHeader">
            <div><h2>Invoice packets</h2><p>PASS invoices are eligible for batch creation. REVIEW and FAIL stay out of the create queue.</p></div>
            <button className="small batchCreateButton" onClick={createAllPass} disabled={!eligiblePass || Boolean(busy)}>{busy === 'Creating PASS invoices' ? 'Creating...' : `Create all PASS (${eligiblePass})`}</button>
          </div>
          <div className="batchTableWrap">
            <table className="batchTable">
              <thead><tr><th>Invoice</th><th>Debtor</th><th>Amount</th><th>Reference</th><th>Docs</th><th>Status</th><th>Needs attention</th><th>Create</th></tr></thead>
              <tbody>
                {analysis.packets.map((packet) => {
                  const primary = packet.documents[packet.primaryIndex]?.fields;
                  const attention = packet.validation.checks.filter((c) => c.status === 'FAIL' || c.status === 'REVIEW');
                  const result = results[packet.packetId];
                  return <tr key={packet.packetId}>
                    <td><strong>{primary?.invoiceNumber || '(unreadable)'}</strong></td>
                    <td>{primary?.debtorName || '-'}</td>
                    <td>{primary?.invoiceAmount == null ? '-' : `$${primary.invoiceAmount.toLocaleString()}`}</td>
                    <td>{primary?.referenceNumber || '-'}</td>
                    <td><span title={packet.documents.map((d) => d.fileName).join('\n')}>{packet.documents.length}</span></td>
                    <td><span className={`pill ${packet.validation.status.toLowerCase()}`}>{packet.validation.status}</span></td>
                    <td className="attentionCell">{attention.length ? attention.map((c) => <span key={c.id}>{c.label}: {c.message}</span>) : <span className="allClear">All checks clear</span>}</td>
                    <td>
                      {result ? <span className={`rowResult ${result.state}`}>{result.message}</span> : packet.validation.status === 'PASS' && packet.debtor && !packet.factorCloudLookupFailed
                        ? <button className="tinyButton" disabled={Boolean(busy)} onClick={() => void createOne(packet)}>Create</button>
                        : <span className="muted">Not eligible</span>}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </section>

        {analysis.unassignedDocuments.length > 0 && <section className="card unassignedCard">
          <h2>Unassigned supporting documents</h2>
          <p>These files were not confidently tied to exactly one invoice. They will not be uploaded or created until someone resolves the grouping.</p>
          <div className="docList">{analysis.unassignedDocuments.map((doc) => <div className="doc" key={doc.fileName}><strong>{doc.fileName}</strong><span>{doc.fields.documentType.replace('_', ' ')}</span><span>Reference: {doc.fields.referenceNumber || '-'}</span></div>)}</div>
        </section>}
      </>}
    </main>
  );
}

function Stat({ label, value, tone = '' }: { label: string; value: string | number; tone?: string }) {
  return <div className={`batchStat ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}
