import 'server-only';

import { randomUUID } from 'crypto';
import { isClosedOut, lifecycleStage } from './analytics';
import { query } from './db';
import { FactorCloudError, fcRequest } from './factorcloud';
import { getInvoiceGroup, invoiceGroupOf } from './funding-api';
import { collectRiskInvoiceRecords, type RiskInvoiceRecord } from './risk';

// People also work invoices in FactorCloud directly. The portal's own lists (the Funding Center and
// Paperwork Review) would then show work that is already done, so before they load, the portal asks
// FactorCloud where each open item stands and catches up:
//   funded or paid there      → marked funded ("in FactorCloud"); review closed
//   approved there            → a held or failed decision becomes approved, ready to fund
//   rejected or deleted there → the decision is closed; the review is closed as rejected
// It never moves money or changes anything in FactorCloud. Checks run at most once a minute per
// factor, cover the most recent open items, and stop early rather than hold the page up.

export type RemoteState = 'FUNDED' | 'APPROVED' | 'REJECTED' | 'DELETED' | 'PENDING';

/** Where an invoice stands in FactorCloud, from its record (null when FactorCloud has no such invoice). */
export function remoteState(record: RiskInvoiceRecord | null): RemoteState {
  if (!record) return 'DELETED';
  if (isClosedOut(record)) return 'REJECTED';
  const stage = lifecycleStage(record);
  if (stage === 'FUNDED' || stage === 'PAID') return 'FUNDED';
  return (record.status ?? '').trim().toUpperCase() === 'APPROVED' ? 'APPROVED' : 'PENDING';
}

export interface SyncResult { checked: number; changed: number; at: string; skipped?: boolean; error?: string }

const MIN_INTERVAL_MS = 60_000;
const MAX_ITEMS = 60;
const CONCURRENCY = 6;
const BUDGET_MS = 6_000;
const last = new Map<string, { at: number; result: SyncResult }>();
const running = new Map<string, Promise<SyncResult>>();

/** Catches the portal up with FactorCloud. Never throws: a failed check leaves things as they were. */
export function syncWithFactorCloud(factorId: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const previous = last.get(factorId);
  const minimum = opts.force ? 10_000 : MIN_INTERVAL_MS;
  if (previous && Date.now() - previous.at < minimum) return Promise.resolve({ ...previous.result, skipped: true });
  const inFlight = running.get(factorId);
  if (inFlight) return inFlight;
  const work = run(factorId)
    .catch((err): SyncResult => { console.error('[factorcloud-sync] failed', err); return { checked: 0, changed: 0, at: new Date().toISOString(), error: 'FactorCloud could not be checked.' }; })
    .then((result) => { last.set(factorId, { at: Date.now(), result }); return result; })
    .finally(() => running.delete(factorId));
  running.set(factorId, work);
  return work;
}

type OpenRun = { id: string; factorcloud_invoice_id: string; state: string; approval_status: string; client_id: string; submission_id: string | null; invoice_number: string | null };
type OpenReview = { review_id: string; submission_id: string; factorcloud_invoice_id: string; client_id: string };

async function run(factorId: string): Promise<SyncResult> {
  const started = Date.now();
  // In-flight approvals and funding are left to their own safeguards and to Recovery.
  const runs = await query<OpenRun>(`
    select id, factorcloud_invoice_id, state, approval_status, client_id, submission_id, invoice_number from engine_runs
    where factor_id = $1 and state in ('SUGGESTED', 'APPROVED', 'FAILED', 'REVIEW') and approval_status in ('IDLE', 'COMPLETE')
    order by updated_at desc limit ${MAX_ITEMS}`, [factorId]);
  const reviews = await query<OpenReview>(`
    select r.id as review_id, r.submission_id, s.factorcloud_invoice_id, s.client_id from review_items r
    join submissions s on s.id = r.submission_id
    where s.factor_id = $1 and r.status = 'OPEN' and s.factorcloud_invoice_id is not null
    order by r.created_at desc limit ${MAX_ITEMS}`, [factorId]);

  const ids = [...new Set([...runs.map((r) => r.factorcloud_invoice_id), ...reviews.map((r) => r.factorcloud_invoice_id)])];
  const states = new Map<string, RemoteState>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
    while (next < ids.length && Date.now() - started < BUDGET_MS) {
      const id = ids[next++];
      try {
        const record = collectRiskInvoiceRecords(await fcRequest(`/invoices/${encodeURIComponent(id)}`)).find((r) => r.id === id);
        // A reply we can't read is left alone, never taken to mean the invoice is gone.
        if (record) states.set(id, remoteState(record));
      } catch (err) {
        // Only a definite "not found" means it was deleted.
        if (err instanceof FactorCloudError && err.status === 404) states.set(id, 'DELETED');
        else console.error(`[factorcloud-sync] could not read ${id}`, err);
      }
    }
  }));

  let changed = 0;
  const audit = (clientId: string | null, submissionId: string | null, data: Record<string, unknown>) =>
    query(`insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data) values ($1,$2,$3,$4,null,'FACTORCLOUD_SYNC',$5::jsonb)`,
      [`audit_${randomUUID()}`, factorId, clientId, submissionId, JSON.stringify(data)]);

  for (const r of runs) {
    const remote = states.get(r.factorcloud_invoice_id);
    if (!remote || remote === 'PENDING') continue;
    // Each update only applies if the run is still where it was when read, so a person's click in
    // the meantime wins.
    const guard = `where id = $1 and state = $2 and approval_status in ('IDLE', 'COMPLETE')`;
    let updated: { id: string }[] = [];
    try {
      if (remote === 'FUNDED') {
        updated = await query(`update engine_runs set state = 'FUNDED', auto_funded = false, funded_at = coalesce(funded_at, now()), funded_by_user_id = null,
          detail = 'Funded in FactorCloud, outside the portal.', updated_at = now() ${guard} returning id`, [r.id, r.state]);
      } else if (remote === 'REJECTED' || remote === 'DELETED') {
        updated = await query(`update engine_runs set state = 'CLOSED', detail = $3, updated_at = now() ${guard} returning id`,
          [r.id, r.state, remote === 'REJECTED' ? 'Rejected in FactorCloud. Nothing left to do here.' : 'No longer in FactorCloud (deleted). Nothing left to do here.']);
      } else if (remote === 'APPROVED' && r.state !== 'APPROVED') {
        const groupId = await invoiceGroupOf(r.factorcloud_invoice_id).catch(() => null);
        const paymentType = groupId ? (await getInvoiceGroup(groupId).catch(() => null))?.paymentType ?? null : null;
        updated = await query(`update engine_runs set state = 'APPROVED', approval_status = 'COMPLETE', invoice_group_id = coalesce($3, invoice_group_id), payment_type = coalesce($4, payment_type),
          detail = 'Approved in FactorCloud. Ready to fund.', updated_at = now() ${guard} returning id`, [r.id, r.state, groupId, paymentType]);
      }
    } catch (err) {
      // For example the CLOSED state before migration 008 is applied: leave this one as it was.
      console.error(`[factorcloud-sync] could not update run ${r.id}`, err);
      continue;
    }
    if (updated.length) {
      changed++;
      await audit(r.client_id, r.submission_id, { runId: r.id, invoiceId: r.factorcloud_invoice_id, invoiceNumber: r.invoice_number, from: r.state, factorCloud: remote });
    }
  }

  for (const r of reviews) {
    const remote = states.get(r.factorcloud_invoice_id);
    if (!remote || remote === 'PENDING') continue;
    const rejected = remote === 'REJECTED' || remote === 'DELETED';
    const note = remote === 'FUNDED' ? 'Funded in FactorCloud.' : remote === 'APPROVED' ? 'Approved in FactorCloud.' : remote === 'REJECTED' ? 'Rejected in FactorCloud.' : 'Deleted in FactorCloud.';
    const closed = await query(`update review_items set status = $2, decision_note = $3, decided_at = now() where id = $1 and status = 'OPEN' returning id`,
      [r.review_id, rejected ? 'REJECTED' : 'APPROVED', note]);
    if (!closed.length) continue;
    await query(`update submissions set workflow_status = $2, updated_at = now() where id = $1`, [r.submission_id, rejected ? 'REJECTED' : 'APPROVED']);
    await query(`update client_tasks set status = 'CANCELED', resolved_at = now() where submission_id = $1 and status = 'OPEN'`, [r.submission_id]);
    changed++;
    await audit(r.client_id, r.submission_id, { reviewId: r.review_id, invoiceId: r.factorcloud_invoice_id, factorCloud: remote });
  }

  return { checked: states.size, changed, at: new Date().toISOString() };
}

/** For tests: forget when each factor was last checked. */
export function resetSyncClock(): void {
  last.clear();
}
