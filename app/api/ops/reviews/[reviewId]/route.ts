import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: Request, context: { params: Promise<{ reviewId: string }> }) {
  if (!databaseAuthEnabled()) return NextResponse.json({ error: 'Database review workflow is not enabled.' }, { status: 503 });
  const session = await requireFactorSession();
  const { reviewId } = await context.params;
  const body = await req.json().catch(() => ({})) as { decision?: 'APPROVE' | 'REJECT'; note?: string | null };
  if (!reviewId || !['APPROVE', 'REJECT'].includes(body.decision || '')) return NextResponse.json({ error: 'A valid review decision is required.' }, { status: 400 });
  const note = body.note?.trim() || null;
  if (body.decision === 'REJECT' && !note) return NextResponse.json({ error: 'A rejection reason is required for the audit trail.' }, { status: 400 });

  const client = await pool().connect();
  try {
    await client.query('begin');
    const found = await client.query(`
      select r.id, r.submission_id, s.client_id, s.factorcloud_invoice_id
      from review_items r
      join submissions s on s.id = r.submission_id
      where r.id = $1 and s.factor_id = $2 and r.status = 'OPEN'
      for update
    `, [reviewId, session.factorId]);
    if (!found.rows[0]) {
      await client.query('rollback');
      return NextResponse.json({ error: 'Open review item not found.' }, { status: 404 });
    }

    const reviewStatus = body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const workflowStatus = body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    await client.query(`
      update review_items
      set status=$1, decided_by_user_id=$2, decision_note=$3, decided_at=now()
      where id=$4
    `, [reviewStatus, session.userId, note, reviewId]);
    await client.query('update submissions set workflow_status=$1, updated_at=now() where id=$2', [workflowStatus, found.rows[0].submission_id]);
    await client.query(`
      insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data)
      values ($1,$2,$3,$4,$5,$6,$7::jsonb)
    `, [
      `audit_${randomUUID()}`,
      session.factorId,
      found.rows[0].client_id,
      found.rows[0].submission_id,
      session.userId,
      body.decision === 'APPROVE' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED',
      JSON.stringify({ note, factorCloudInvoiceId: found.rows[0].factorcloud_invoice_id || null }),
    ]);
    await client.query('commit');
    return NextResponse.json({ ok: true, status: reviewStatus });
  } catch (err) {
    await client.query('rollback');
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    client.release();
  }
}
