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
  const approvalUnknown = items.filter((item) => item.kind === 'APPROVAL_UNKNOWN').length;
  const otherRecovery = items.length - fundingUnknown - approvalUnknown;
  const oldest = items.length ? [...items].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] : null;

  return <main className={`opsShell ${styles.page}`}>
    <OpsSidebar active="recovery" />
    <section className="opsContent"><div className="oc-topbar"><span>Factor workspace / <strong>Recovery</strong></span></div>
      <header className={styles.header}>
        <div>
          <span className="eyebrow">Automation center</span>
          <h1>Recovery</h1>
          <p>This queue is for the small number of cases where the portal cannot safely tell whether a remote FactorCloud action finished. Nothing here should be blindly retried.</p>
        </div>
        <button className="small opsRefresh" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </header>

      <div className={styles.explainer}>
        <span className={styles.explainerIcon}>!</span>
        <div><strong>Verify in FactorCloud before you close anything here.</strong><span>For invoice creation, approval, or funding uncertainty, confirm the remote state first. Recovery choices deliberately do not rerun a financial action automatically.</span></div>
      </div>

      {error && <div className="attentionSummary fail"><strong>Could not load recovery</strong><span>{error}</span></div>}
      {note && <div className="attentionSummary review"><strong>Recovery note</strong><span>{note}</span></div>}

      {!loading && !note && !error && <section className={styles.summary}>
        <Metric label="Open recovery" value={items.length} detail="Items that still need reconciliation" />
        <Metric label="Approval uncertain" value={approvalUnknown} detail="Confirm whether approval completed" />
        <Metric label="Funding uncertain" value={fundingUnknown} detail="Confirm whether the batch funded" />
        <Metric label="Invoice / document" value={otherRecovery} detail={oldest ? `Oldest opened ${when(oldest.created_at)}` : 'No invoice or document repairs'} />
      </section>}

      {error || note ? <div className={styles.empty}><strong>Recovery data unavailable</strong><span>Connection or database access must be restored before the queue can be assessed.</span></div> : loading ? <div className={styles.empty}><strong>Loading recovery queue…</strong><span>Checking unresolved automation outcomes.</span></div> : items.length === 0 ? <div className={styles.empty}><strong>Recovery queue is clear</strong><span>No uncertain automation outcomes need a person right now.</span></div> : <div className={styles.list}>
        {items.map((item) => <RecoveryCard key={item.id} item={item} editable={editable} onDone={load} />)}
      </div>}
    </section>
  </main>;
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className={styles.metric}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function RecoveryCard({ item, editable, onDone }: { item: Item; editable: boolean; onDone: () => Promise<void> }) {
  const [evidence, setEvidence] = useState('');
  const [outcome, setOutcome] = useState('');
  const [invoiceId, setInvoiceId] = useState(item.factorcloud_invoice_id ?? '');
  const [invoiceGroupId, setInvoiceGroupId] = useState('');
  const [paymentType, setPaymentType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const needsInvoiceId = item.kind === 'CREATE_UNKNOWN' && outcome === 'created';
  const needsApprovalDetails = item.kind === 'APPROVAL_UNKNOWN' && outcome === 'approved';
  const requiredDetailsMissing = (needsInvoiceId && !invoiceId.trim()) || (needsApprovalDetails && (!invoiceGroupId.trim() || !paymentType.trim()));

  async function resolve() {
    setBusy(true);
    setError('');
    try {
      const payload: Record<string, string> = { id: item.id, evidence, outcome };
      if (needsInvoiceId) payload.invoiceId = invoiceId.trim();
      if (needsApprovalDetails) {
        payload.invoiceGroupId = invoiceGroupId.trim();
        payload.paymentType = paymentType.trim();
      }
      const response = await fetch('/api/ops/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
      <div className={styles.checks}>{checklist(item.kind).map((step) => <span key={step}>{step}</span>)}</div>

      {editable ? <div className={styles.form}>
        <label><span>Verified outcome</span><select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="">Choose the verified outcome</option>{outcomeOptions(item).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        {needsInvoiceId && <label><span>FactorCloud invoice ID</span><input value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)} placeholder="Paste the verified FactorCloud invoice ID" /></label>}
        {needsApprovalDetails && <>
          <label><span>Invoice group / batch ID</span><input value={invoiceGroupId} onChange={(event) => setInvoiceGroupId(event.target.value)} placeholder="Paste the verified invoice group ID" /></label>
          <label><span>Payment type</span><input value={paymentType} onChange={(event) => setPaymentType(event.target.value)} placeholder="Example: ACH" /></label>
        </>}
        <label><span>Evidence / reference</span><textarea value={evidence} maxLength={2000} onChange={(event) => setEvidence(event.target.value)} placeholder={evidencePlaceholder(item.kind)} /></label>
        <button disabled={busy || !outcome || evidence.trim().length < 15 || requiredDetailsMissing} onClick={() => void resolve()}>{busy ? 'Saving…' : 'Record reconciliation'}</button>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div> : <div className={styles.readOnly}>A factor admin must record the reconciliation. You can still inspect the invoice timeline and verify the FactorCloud state.</div>}
    </div>
  </article>;
}


function outcomeOptions(item: Item): Array<{ value: string; label: string }> {
  if (item.kind === 'FUNDING_UNKNOWN') return [
    { value: 'funded', label: 'Batch is funded in FactorCloud' },
    { value: 'not-funded', label: 'Batch is definitely not funded' },
  ];
  if (item.kind === 'APPROVAL_UNKNOWN') return [
    { value: 'approved', label: 'Approval completed in FactorCloud' },
    { value: 'not-approved', label: 'Invoice is definitely not approved' },
  ];
  if (item.kind === 'CREATE_UNKNOWN') {
    const options = [{ value: 'created', label: 'Invoice exists in FactorCloud' }];
    if (!item.factorcloud_invoice_id) options.push({ value: 'not-created', label: 'Invoice was definitely not created' });
    return options;
  }
  return [{ value: 'repaired', label: 'Repaired and checked in FactorCloud' }];
}

function checklist(kind: string): string[] {
  if (kind === 'FUNDING_UNKNOWN') return [
    'Open the matching funding batch in FactorCloud.',
    'Confirm whether the funding transaction actually completed.',
    'Record a concrete batch, transaction, or ledger reference for the audit trail.',
  ];
  if (kind === 'APPROVAL_UNKNOWN') return [
    'Open the invoice in FactorCloud and inspect its current approval state.',
    'If approved, verify the invoice group or batch ID and payment type before recording it here.',
    'If not approved, confirm no remote approval completed before allowing a fresh attempt.',
  ];
  if (kind === 'CREATE_UNKNOWN') return [
    'Search FactorCloud using the client and invoice number shown on this submission.',
    'If the invoice exists, verify the exact FactorCloud invoice ID before linking it.',
    'If it does not exist, confirm that carefully before releasing the submission for retry.',
  ];
  return [
    'Open the matching invoice in FactorCloud.',
    'Repair the incomplete document state in FactorCloud first.',
    'Record a concrete reference or observation so another operator can audit the decision later.',
  ];
}

function evidencePlaceholder(kind: string): string {
  if (kind === 'FUNDING_UNKNOWN') return 'Example: Batch ACH266 shows Funded, transaction ID 12345.';
  if (kind === 'APPROVAL_UNKNOWN') return 'Example: FactorCloud invoice shows Approved for Funding in group DKWZLB-1004; payment type ACH.';
  if (kind === 'CREATE_UNKNOWN') return 'Example: Searched client and invoice number in FactorCloud; invoice ID abc123 exists and matches the submission.';
  return 'Example: Reattached the POD in FactorCloud and verified it appears on the invoice.';
}

function kindLabel(kind: string): string {
  if (kind === 'FUNDING_UNKNOWN') return 'Funding uncertain';
  if (kind === 'APPROVAL_UNKNOWN') return 'Approval uncertain';
  if (kind.includes('DOCUMENT')) return 'Document repair';
  if (kind.includes('CREATE')) return 'Invoice create uncertain';
  return kind.replaceAll('_', ' ').toLowerCase();
}

function when(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : value;
}
