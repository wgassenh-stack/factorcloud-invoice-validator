import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { pilotAdminViews, requireFactorSession } from '@/lib/portal-auth';
import { apiErrorResponse } from '@/lib/api-errors';
import { decideDemoReview, demoRequestFix } from '@/lib/demo-store';
import { demoRequest } from '@/lib/demo-request';
import { ensureWorkflowSchema } from '@/lib/schema';
import { syncDecisionToFactorCloud } from '@/lib/decision-sync';

export const runtime = 'nodejs';

type Decision = 'APPROVE' | 'REJECT' | 'REQUEST_FIX';

export async function POST(req: Request, context: { params: Promise<{ reviewId: string }> }) {
  let session;
  try { session = await requireFactorSession(); }
  catch (err) { return apiErrorResponse(err, 'ops-review-decision'); }
  const { reviewId } = await context.params;
  const body = await req.json().catch(() => ({})) as { decision?: Decision; note?: string | null };
  const decision = body.decision;
  if (!reviewId || !decision || !['APPROVE', 'REJECT', 'REQUEST_FIX'].includes(decision)) return NextResponse.json({ error: 'A valid review decision is required.' }, { status: 400 });
  const note = body.note?.trim() || null;
  if (decision === 'REJECT' && !note) return NextResponse.json({ error: 'A rejection reason is required for the audit trail.' }, { status: 400 });
  if (decision === 'REQUEST_FIX' && !note) return NextResponse.json({ error: 'Tell the client what to fix.' }, { status: 400 });
  if (note && note.length > 1000) return NextResponse.json({ error: 'Keep the note under 1,000 characters.' }, { status: 400 });

  if (await demoRequest()) {
    const done = decision === 'REQUEST_FIX' ? demoRequestFix(reviewId, note!) : decideDemoReview(reviewId, decision, note);
    return done ? NextResponse.json({ ok: true, status: decision === 'REQUEST_FIX' ? 'FIX_REQUESTED' : done.status }) : NextResponse.json({ error: 'Open review item not found.' }, { status: 404 });
  }

  if (pilotAdminViews()) return NextResponse.json({ error: 'Decide on this invoice in FactorCloud. This setup has no portal database to record decisions.' }, { status: 409 });

  try { await ensureWorkflowSchema(); }
  catch (err) { return apiErrorResponse(err, 'ops-review-decision'); }

  const client = await pool().connect();
  let found: { submission_id: string; client_id: string; factorcloud_invoice_id: string | null; invoice_number_submitted: string | null } | undefined;
  try {
    await client.query('begin');
    found = (await client.query(`
      select r.id, r.submission_id, s.client_id, s.factorcloud_invoice_id, s.invoice_number_submitted
      from review_items r
      join submissions s on s.id = r.submission_id
      where r.id = $1 and s.factor_id = $2 and r.status = 'OPEN'
      for update
    `, [reviewId, session.factorId])).rows[0];
    if (!found) {
      await client.query('rollback');
      return NextResponse.json({ error: 'Open review item not found.' }, { status: 404 });
    }

    if (decision === 'REQUEST_FIX') {
      // The review stays open: the reviewer decides once the client has answered.
      await client.query(`update client_tasks set status='CANCELED', resolved_at=now() where submission_id=$1 and status='OPEN'`, [found.submission_id]);
      await client.query(`
        insert into client_tasks (id, factor_id, client_id, submission_id, review_id, message, requested_by_user_id)
        values ($1,$2,$3,$4,$5,$6,$7)
      `, [`task_${randomUUID()}`, session.factorId, found.client_id, found.submission_id, reviewId, note, session.userId]);
      // The submission stays REVIEW_REQUIRED; the open client task is what marks it as waiting on the client.
      await client.query(`update submissions set updated_at=now() where id=$1`, [found.submission_id]);
    } else {
      const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await client.query(`update review_items set status=$1, decided_by_user_id=$2, decision_note=$3, decided_at=now() where id=$4`, [status, session.userId, note, reviewId]);
      await client.query('update submissions set workflow_status=$1, updated_at=now() where id=$2', [status, found.submission_id]);
      await client.query(`update client_tasks set status='CANCELED', resolved_at=now() where submission_id=$1 and status='OPEN'`, [found.submission_id]);
    }

    await client.query(`
      insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data)
      values ($1,$2,$3,$4,$5,$6,$7::jsonb)
    `, [
      `audit_${randomUUID()}`, session.factorId, found.client_id, found.submission_id, session.userId,
      decision === 'APPROVE' ? 'REVIEW_APPROVED' : decision === 'REJECT' ? 'REVIEW_REJECTED' : 'FIX_REQUESTED',
      JSON.stringify({ note, factorCloudInvoiceId: found.factorcloud_invoice_id || null }),
    ]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    return apiErrorResponse(err, 'ops-review-decision');
  } finally {
    client.release();
  }

  // Written back to FactorCloud after the portal has saved the decision; a failure there is reported
  // but never undoes it.
  let factorCloud: { ok: boolean; detail: string } | null = null;
  if (found.factorcloud_invoice_id) {
    factorCloud = await syncDecisionToFactorCloud({ invoiceId: found.factorcloud_invoice_id, decision, reviewer: session.displayName || session.email, note });
    try {
      await pool().query(`
        insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data)
        values ($1,$2,$3,$4,$5,$6,$7::jsonb)
      `, [`audit_${randomUUID()}`, session.factorId, found.client_id, found.submission_id, session.userId,
        factorCloud.ok ? 'FACTORCLOUD_DECISION_SYNCED' : 'FACTORCLOUD_DECISION_SYNC_FAILED', JSON.stringify({ decision, detail: factorCloud.detail })]);
    } catch { /* the decision itself is saved */ }
  }

  return NextResponse.json({ ok: true, status: decision === 'REQUEST_FIX' ? 'FIX_REQUESTED' : decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', factorCloud });
}
