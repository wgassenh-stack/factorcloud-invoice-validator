'use client';

import { clientExplanation, flaggedChecks } from '@/lib/override';
import { useEffect, useMemo, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import { CountUp, Skeleton, StatusFlag, VizEmpty } from '@/app/components/CommandCharts';
import { DemoBadge } from '@/app/components/DemoBadge';
import type { CheckResult } from '@/lib/types';
import styles from './ReviewQueue.module.css';

type ReviewRecord = {
  id: string;
  reviewId?: string;
  submissionId?: string;
  invoiceNumber: string | null;
  companyClientId: string | null;
  companyDebtorId: string | null;
  invoiceAmount: number | null;
  invoiceDate: string | null;
  status: string | null;
  reviewStatus?: string;
  reason?: string;
  notes?: string | null;
  createdAt?: string;
  checks?: CheckResult[];
  fix?: { status: 'OPEN' | 'DONE'; message: string; requestedAt: string; answeredAt: string | null; responseNote: string | null; fileCount: number | null } | null;
};

type Decision = 'APPROVE' | 'REJECT' | 'REQUEST_FIX';

const FIX_PRESETS = ['Signed POD is missing.', 'Load number on the BOL doesn\'t match the invoice.', 'Please add the rate confirmation.', 'Invoice amount doesn\'t match the rate confirmation.'];

type ReviewResponse = {
  records: ReviewRecord[];
  clientNames: Record<string, string>;
  debtorNames: Record<string, string>;
  source: { note: string };
  error?: string;
};

export default function ReviewQueuePage() {
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [deciding, setDeciding] = useState('');
  const [leaving, setLeaving] = useState('');
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);
  const now = useNow(30_000);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/ops/reviews', { cache: 'no-store' });
      const body = await res.json() as ReviewResponse;
      if (!res.ok) throw new Error(body.error || 'Could not load review queue.');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function decide(record: ReviewRecord, decision: Decision, note: string | null) {
    if (!record.reviewId) return;
    if (decision !== 'APPROVE' && !note?.trim()) {
      setError(decision === 'REJECT' ? 'Add a short reason before rejecting a client submission.' : 'Tell the client what to fix.');
      return;
    }
    setDeciding(record.reviewId);
    setError('');
    try {
      const res = await fetch(`/api/ops/reviews/${encodeURIComponent(record.reviewId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note?.trim() || null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not save review decision.');
      const label = record.invoiceNumber || record.id.slice(0, 8);
      const synced = body.factorCloud as { ok: boolean; detail: string } | null | undefined;
      const fc = synced ? (synced.ok ? ' · FactorCloud updated' : ' · FactorCloud not updated') : '';
      if (synced && !synced.ok) setError(synced.detail);
      if (decision === 'REQUEST_FIX') {
        setToast({ tone: 'pass', text: `Fix requested on ${label}${fc}` });
        setTimeout(() => setToast(null), 3200);
        await load();
        return;
      }
      setLeaving(record.reviewId);
      setToast({ tone: decision === 'APPROVE' ? 'pass' : 'fail', text: `${decision === 'APPROVE' ? 'Approved' : 'Rejected'} invoice ${label}${fc}` });
      setTimeout(() => {
        setLeaving('');
        setData((current) => current ? { ...current, records: current.records.filter((r) => r.reviewId !== record.reviewId) } : current);
      }, 420);
      setTimeout(() => setToast(null), 3200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding('');
    }
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return data?.records ?? [];
    return (data?.records ?? []).filter((record) => {
      const client = record.companyClientId ? data?.clientNames[record.companyClientId] || record.companyClientId : '';
      const debtor = record.companyDebtorId ? data?.debtorNames[record.companyDebtorId] || record.companyDebtorId : '';
      return [record.invoiceNumber, client, debtor, record.status, record.reason].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [data, query]);

  const waitingOnClient = data?.records.filter((record) => record.fix?.status === 'OPEN').length ?? 0;
  const clientResponded = data?.records.filter((record) => record.fix?.status === 'DONE').length ?? 0;

  return <main className={`opsShell ${styles.page}`}>
    <OpsSidebar active="reviews" />

    <section className="opsContent">
      <header className={styles.header}>
        <div>
          <div className={styles.meta}><span className="eyebrow">Workspace</span><span className={styles.queuePill}>Exception queue</span></div>
          <h1>Review Queue</h1>
          <p>Resolve paperwork and validation exceptions before an invoice can continue into approval and funding.</p>
        </div>
        <button className={styles.refresh} onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </header>

      {error && <div className={styles.alert}><strong>Could not load review queue.</strong> {error}</div>}

      {loading && !data && <Skeleton height={120} lines={4} />}

      {data && <>
        <section className={styles.metricGrid}>
          <Metric label="Needs review" value={<CountUp value={data.records.length} />} detail="Open exceptions" tone={data.records.length ? 'review' : 'good'} />
          <Metric label="Invoice amount" value={<CountUp value={data.records.reduce((sum, record) => sum + (record.invoiceAmount ?? 0), 0)} format={money} />} detail="Value waiting on review" />
          <Metric label="Oldest waiting" value={oldestWait(data.records, now)} detail="Target: decide within 4 hours" tone={oldestWaitHours(data.records, now) >= 4 ? 'review' : 'good'} />
          <Metric label="Waiting on client" value={waitingOnClient} detail={clientResponded ? `${clientResponded} client response${clientResponded === 1 ? '' : 's'} ready` : 'Fix requests still open'} tone={waitingOnClient ? 'review' : 'good'} />
        </section>

        <section className={styles.queuePanel}>
          <div className={styles.panelHeader}>
            <div><span>Human decisions</span><h2>Items requiring factor review <DemoBadge /></h2><p>{data.source.note}</p></div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search invoice, client, or debtor" />
          </div>

          <div className={styles.reviewList}>
            {filtered.map((record, index) => <ReviewCard
              key={record.reviewId || record.id}
              record={record}
              index={index}
              now={now}
              clientName={record.companyClientId ? data.clientNames[record.companyClientId] || record.companyClientId : '-'}
              debtorName={record.companyDebtorId ? data.debtorNames[record.companyDebtorId] || record.companyDebtorId : '-'}
              busy={deciding === record.reviewId}
              disabled={Boolean(deciding)}
              leaving={leaving === record.reviewId}
              onDecide={(decision, note) => void decide(record, decision, note)}
            />)}
            {!loading && !filtered.length && <div className={styles.empty}><VizEmpty title={query ? 'No matching review items' : 'Queue is clear'} detail={query ? 'Try a different invoice, client or debtor.' : 'New submissions needing a human decision will appear here.'} /></div>}
          </div>
        </section>
      </>}
      {toast && <div className={`reviewToast ${toast.tone}`} role="status"><b>{toast.tone === 'pass' ? '✓' : '✕'}</b>{toast.text}</div>}
    </section>
  </main>;
}

function ReviewCard({ record, index, now, clientName, debtorName, busy, disabled, leaving, onDecide }: {
  record: ReviewRecord; index: number; now: number; clientName: string; debtorName: string; busy: boolean; disabled: boolean; leaving: boolean;
  onDecide: (decision: Decision, note: string | null) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'reject' | 'fix'>('idle');
  const [note, setNote] = useState('');
  const hours = record.createdAt ? (now - Date.parse(record.createdAt)) / 3_600_000 : null;
  const sla = hours == null ? null : hours < 4 ? 'GOOD' : hours < 24 ? 'REVIEW' : 'HIGH';
  const flagged = flaggedChecks(record.checks);
  const clientNote = clientExplanation(record.checks);

  return <article className={`reviewCard ${leaving ? 'leaving' : ''}`} style={{ animationDelay: `${index * 50}ms` }}>
    <div className="reviewCardMain">
      <div className="reviewCardTop">
        {record.submissionId ? <a className="reviewCardTitle" href={`/ops/submissions/${encodeURIComponent(record.submissionId)}`}>Invoice {record.invoiceNumber || record.id.slice(0, 8)}</a> : <strong className="reviewCardTitle">Invoice {record.invoiceNumber || record.id.slice(0, 8)}</strong>}
        {sla && <StatusFlag level={sla as 'GOOD' | 'REVIEW' | 'HIGH'}>Waiting {waitCopy(hours!)}</StatusFlag>}
        {record.fix?.status === 'OPEN' && <span className="fixChip waiting">Waiting on client · asked {waitCopy((now - Date.parse(record.fix.requestedAt)) / 3_600_000)} ago</span>}
        {record.fix?.status === 'DONE' && <span className="fixChip answered">Client responded{record.fix.fileCount ? ` · ${record.fix.fileCount} file${record.fix.fileCount === 1 ? '' : 's'}` : ''}</span>}
      </div>
      <div className="reviewCardMeta">
        {record.companyClientId ? <a href={`/ops/clients/${encodeURIComponent(record.companyClientId)}`}>{clientName}</a> : <span>{clientName}</span>}
        <span>→ {debtorName}</span>
        <span>{record.invoiceDate || 'No date'}</span>
      </div>
      <p className="reviewCardReason">{flagged.length ? flagged.map((check) => check.label).join(', ') : record.reason || pretty(record.status || 'Review required')}</p>
      {clientNote && <div className="clientNote"><b>Submitted anyway. Client's note</b><span>“{clientNote}”</span></div>}
      {record.fix && <div className={`fixThread ${record.fix.status === 'DONE' ? 'answered' : ''}`}>
        <div><b>You asked</b><span>{record.fix.message}</span></div>
        {record.fix.status === 'DONE' && <div><b>Client</b><span>{record.fix.responseNote || 'Uploaded the requested files.'}{record.submissionId && <> · <a href={`/ops/submissions/${encodeURIComponent(record.submissionId)}`}>see files</a></>}</span></div>}
      </div>}
      {flagged.length > 0 && <div className="reviewChecks">
        {flagged.map((check) => <div className={`reviewCheck ${check.status.toLowerCase()}`} key={check.id}>
          <b aria-hidden="true">{check.status === 'FAIL' ? '✕' : '!'}</b>
          <div><strong>{check.label}</strong><span>{check.message}</span>
            {check.comparisons?.map((c, i) => <em key={i}>{c.label}: <mark>{c.document}</mark>{c.other && <> vs <mark>{c.other}</mark></>}</em>)}
          </div>
        </div>)}
      </div>}
    </div>
    <div className="reviewCardSide">
      <strong className="reviewCardAmount">{record.invoiceAmount == null ? '-' : money(record.invoiceAmount)}</strong>
      {record.reviewId ? (mode !== 'idle'
        ? <div className="reviewReject">
            {mode === 'fix' && <div className="fixPresets">{FIX_PRESETS.map((preset) => <button type="button" key={preset} onClick={() => setNote(preset)}>{preset}</button>)}</div>}
            <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'fix' ? 'What should the client fix or send?' : 'Reason for the client and the audit trail'} rows={3} />
            <div>
              <button className="tinyButton" onClick={() => { setMode('idle'); setNote(''); }} disabled={disabled}>Cancel</button>
              {mode === 'fix'
                ? <button className="tinyButton fixButton" disabled={disabled || !note.trim()} onClick={() => onDecide('REQUEST_FIX', note)}>{busy ? 'Sending...' : 'Send to client'}</button>
                : <button className="tinyButton dangerButton" disabled={disabled || !note.trim()} onClick={() => onDecide('REJECT', note)}>{busy ? 'Saving...' : 'Reject'}</button>}
            </div>
          </div>
        : <div className="reviewActions">
            <button className="reviewApprove" disabled={disabled} onClick={() => onDecide('APPROVE', null)}>{busy ? 'Saving...' : 'Clear review'}</button>
            {record.fix?.status !== 'OPEN' && <button className="tinyButton fixButton" disabled={disabled} onClick={() => setMode('fix')}>Request fix…</button>}
            <button className="tinyButton dangerButton" disabled={disabled} onClick={() => setMode('reject')}>Reject…</button>
          </div>)
        : <span className="muted">Decide in FactorCloud</span>}
    </div>
  </article>;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function waitCopy(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m`;
  return `${Math.floor(hours / 24)}d ${Math.floor(hours % 24)}h`;
}

function oldestWait(records: ReviewRecord[], now: number): string {
  const oldest = records.map((r) => r.createdAt).filter((d): d is string => Boolean(d)).sort()[0];
  return oldest ? waitCopy((now - Date.parse(oldest)) / 3_600_000) : '-';
}

function oldestWaitHours(records: ReviewRecord[], now: number): number {
  const oldest = records.map((r) => r.createdAt).filter((d): d is string => Boolean(d)).sort()[0];
  return oldest ? (now - Date.parse(oldest)) / 3_600_000 : 0;
}

function Metric({ label, value, detail, tone = '' }: { label: string; value: React.ReactNode; detail?: string; tone?: string }) {
  return <div className={styles.metric} data-tone={tone}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function pretty(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}
