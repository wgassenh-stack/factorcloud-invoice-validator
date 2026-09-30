'use client';

import { useEffect, useState } from 'react';
import { OpsSidebar } from '@/app/components/OpsSidebar';
import styles from './RecoveryPage.module.css';

type Item = {
  id: string;
  kind: string;
  detail: string;
  created_at: string;
  submission_id: string | null;
  invoice_number: string | null;
  factorcloud_invoice_id: string | null;
};

type Response = { items: Item[]; editable: boolean; note?: string };

export default function RecoveryPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [editable, setEditable] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/ops/recovery', { cache: 'no-store' });
      const body = await response.json() as Response & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not load recovery items.');
      setItems(body.items ?? []);
      setEditable(body.editable);
      setNote(body.note ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const fundingUnknown = items.filter((item) => item.kind === 'FUNDING_UNKNOWN').length;
  const documentRecovery = items.length - fundingUnknown;
  const oldest = items.length ? [...items].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] : null;

  return <main className={`opsShell ${styles.page}`}>
    <OpsSidebar active="recovery" />
    <section className="opsContent">
      <header className={styles.header}>
        <div>
          <span className="eyebrow">Automation center</span>
          <h1>Recovery & reconciliation</h1>
          <p>This queue is for the small number of cases where the portal cannot safely tell whether a remote FactorCloud action finished. Nothing here should be blindly retried.</p>
        </div>
        <button className="small opsRefresh" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </header>

      <div className={styles.explainer}>
        <span className={styles.explainerIcon}>!</span>
        <div><strong>Verify in FactorCloud before you close anything here.</strong><span>For funding uncertainty, confirm whether money actually moved. For document or invoice issues, repair the record in FactorCloud first, then record what you checked for the audit trail.</span></div>
      </div>

      {error && <div className="attentionSummary fail"><strong>Could not load recovery</strong><span>{error}</span></div>}
      {note && <div className="attentionSummary review"><strong>Recovery note</strong><span>{note}</span></div>}

      {!loading && <section className={styles.summary}>
        <Metric label="Open recovery" value={items.length} detail="Items that still need reconciliation" />
        <Metric label="Funding uncertain" value={fundingUnknown} detail="Confirm whether the batch funded" />
        <Metric label="Other repairs" value={documentRecovery} detail={oldest ? `Oldest opened ${when(oldest.created_at)}` : 'No document or invoice repairs'} />
      </section>}

      {loading ? <div className={styles.empty}><strong>Loading recovery queue…</strong><span>Checking unresolved automation outcomes.</span></div> : items.length === 0 ? <div className={styles.empty}><strong>Recovery queue is clear</strong><span>No uncertain automation outcomes need a person right now.</span></div> : <div className={styles.list}>
        {items.map((item) => <RecoveryCard key={item.id} item={item} editable={editable} onDone={load} />)}
      </div>}
    </section>
  </main>;
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function RecoveryCard({ item, editable, onDone }: { item: Item; editable: boolean; onDone: () => Promise<void> }) {
  const fundingUnknown = item.kind === 'FUNDING_UNKNOWN';
  const [evidence, setEvidence] = useState('');
  const [outcome, setOutcome] = useState(fundingUnknown ? 'funded' : 'repaired');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function resolve() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/ops/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, evidence, outcome }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not reconcile this item.');
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return <article className={styles.card}>
    <div className={styles.cardTop}>
      <div className={styles.identity}>
        <div className={styles.identityTop}><h2>{item.invoice_number ? `Invoice ${item.invoice_number}` : 'Invoice recovery'}</h2><span className={styles.kind}>{kindLabel(item.kind)}</span></div>
        <p>{item.detail}</p>
        <span className={styles.meta}>Opened {when(item.created_at)} · FactorCloud invoice {item.factorcloud_invoice_id ?? 'not confirmed'}</span>
      </div>
      {item.submission_id && <a className={styles.timelineLink} href={`/ops/submissions/${encodeURIComponent(item.submission_id)}`}>View invoice timeline →</a>}
    </div>

    <div className={styles.body}>
      <div className={styles.checks}>
        <span>Open the matching invoice or funding batch in FactorCloud.</span>
        <span>{fundingUnknown ? 'Confirm whether the funding transaction actually completed.' : 'Repair the incomplete invoice or document state in FactorCloud.'}</span>
        <span>Record a concrete reference or observation so another operator can audit the decision later.</span>
      </div>

      {editable ? <div className={styles.form}>
        <label><span>Verified outcome</span><select value={outcome} onChange={(event) => setOutcome(event.target.value)}>{fundingUnknown ? <><option value="funded">Batch is funded in FactorCloud</option><option value="not-funded">Batch is definitely not funded</option></> : <option value="repaired">Repaired and checked in FactorCloud</option>}</select></label>
        <label><span>Evidence / reference</span><textarea value={evidence} maxLength={2000} onChange={(event) => setEvidence(event.target.value)} placeholder="Example: Batch ACH266 shows Funded, transaction ID …" /></label>
        <button disabled={busy || evidence.trim().length < 15} onClick={() => void resolve()}>{busy ? 'Saving…' : 'Record reconciliation'}</button>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div> : <div className={styles.readOnly}>A factor admin must record the reconciliation. You can still inspect the invoice timeline and verify the FactorCloud state.</div>}
    </div>
  </article>;
}

function kindLabel(kind: string): string {
  if (kind === 'FUNDING_UNKNOWN') return 'Funding uncertain';
  if (kind.includes('DOCUMENT')) return 'Document repair';
  if (kind.includes('CREATE')) return 'Invoice create uncertain';
  return kind.replaceAll('_', ' ').toLowerCase();
}

function when(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : value;
}
