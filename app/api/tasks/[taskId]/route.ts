import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { apiErrorResponse, publicErrorMessage } from '@/lib/api-errors';
import { isDefinitiveCreateFailure } from '@/lib/errors';
import { clientTask } from '@/lib/client-tasks';
import { pool } from '@/lib/db';
import { demoRequest } from '@/lib/demo-request';
import { demoSubmitFix } from '@/lib/demo-store';
import { isSupportedFile } from '@/lib/extract';
import { addDocumentsToInvoice, FC_DOCUMENT_TYPES, uploadDocument } from '@/lib/factorcloud';
import { requirePortalSession, resolveConfiguredClientId } from '@/lib/portal-auth';
import { hashFile } from '@/lib/submission-integrity';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_FILES = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The client answers a fix request: upload files to the same FactorCloud invoice, back to review. */
export async function POST(req: Request, context: { params: Promise<{ taskId: string }> }) {
  let clientId: string;
  try { clientId = await resolveConfiguredClientId(); }
  catch (err) { return apiErrorResponse(err, 'client-task-fix'); }
  const { taskId } = await context.params;

  const form = await req.formData();
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  const note = String(form.get('note') ?? '').trim().slice(0, 1000) || null;
  const documentType = FC_DOCUMENT_TYPES[String(form.get('documentType') ?? 'other')] ?? 'OTHER';
  if (!files.length) return NextResponse.json({ error: 'Add at least one file.' }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Upload at most ${MAX_FILES} files.` }, { status: 400 });
  if (files.some((f) => f.size > MAX_FILE_BYTES)) return NextResponse.json({ error: 'Each file must be 10 MB or smaller.' }, { status: 413 });
  if (files.some((f) => !isSupportedFile(f.type))) return NextResponse.json({ error: 'Use PDF, PNG, JPEG, GIF or WebP files.' }, { status: 400 });

  if (await demoRequest()) {
    const task = demoSubmitFix(taskId, clientId, files.map((f) => ({ fileName: f.name, sizeBytes: f.size })), note);
    return task ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'This request is no longer open.' }, { status: 404 });
  }

  let session;
  try { session = await requirePortalSession(); }
  catch (err) { return apiErrorResponse(err, 'client-task-fix'); }
  const task = await clientTask(taskId, session.factorId, clientId).catch(() => null);
  if (!task || task.status !== 'OPEN') return NextResponse.json({ error: 'This request is no longer open.' }, { status: 404 });
  if (!task.invoiceId) return NextResponse.json({ error: 'This submission has no FactorCloud invoice to attach files to. Contact your factor.' }, { status: 409 });

  // Claim the request before anything reaches FactorCloud, so two answers sent at once can't both
  // upload. The claim is a recovery item: if this process dies mid-way, it stays behind and the factor
  // sees it in Recovery after a few minutes instead of the client uploading the same files again.
  const claimId = `rec_${randomUUID()}`;
  {
    const db = await pool().connect();
    try {
      await db.query('begin');
      const { rows: [open] } = await db.query(`select id from client_tasks where id=$1 and status='OPEN' for update`, [taskId]);
      if (!open) { await db.query('rollback'); return NextResponse.json({ error: 'This request was already answered.' }, { status: 409 }); }
      const { rows: [busy] } = await db.query(`select kind from recovery_items where submission_id=$1 and status='OPEN' and kind in ('FIX_SENDING','FIX_ATTACH_UNKNOWN')`, [task.submissionId]);
      if (busy) {
        await db.query('rollback');
        return NextResponse.json({ error: busy.kind === 'FIX_SENDING' ? 'Your files for this request are already being sent. Wait a moment and refresh.' : 'Your factor is checking whether your earlier files reached FactorCloud. You don\'t need to send them again.' }, { status: 409 });
      }
      await db.query(`insert into recovery_items(id,factor_id,submission_id,kind,detail) values($1,$2,$3,'FIX_SENDING',$4)`,
        [claimId, session.factorId, task.submissionId, `A client's fix for invoice ${task.invoiceId} was being sent (${files.map((f) => f.name).join(', ')}) and did not finish. Check the invoice's documents in FactorCloud.`]);
      await db.query('commit');
    } catch (err) {
      await db.query('rollback');
      return apiErrorResponse(err, 'client-task-fix');
    } finally {
      db.release();
    }
  }
  const settle = (kind: 'FIX_ATTACH_UNKNOWN' | null, detail?: string) => (kind
    ? pool().query(`update recovery_items set kind=$2, detail=$3 where id=$1`, [claimId, kind, detail])
    : pool().query(`delete from recovery_items where id=$1 and kind='FIX_SENDING'`, [claimId])).catch((err) => console.error('[client-task-fix] could not update the claim', err));

  const documentIds: string[] = [];
  try {
    for (const file of files) documentIds.push((await uploadDocument(clientId, file, documentType)).id);
  } catch (err) {
    // Nothing was attached to the invoice, so the client can safely try again.
    await settle(null);
    return NextResponse.json({ error: `FactorCloud did not accept the files: ${publicErrorMessage(err, 'client-task-fix')} Nothing was marked as fixed; you can try again.` }, { status: 502 });
  }
  try {
    await addDocumentsToInvoice(task.invoiceId, documentIds);
  } catch (err) {
    if (isDefinitiveCreateFailure(err)) {
      await settle(null);
      return NextResponse.json({ error: `FactorCloud did not accept the files: ${publicErrorMessage(err, 'client-task-fix')} Nothing was marked as fixed; you can try again.` }, { status: 502 });
    }
    // No clear answer: the files may be attached. Sending them again could duplicate them.
    await settle('FIX_ATTACH_UNKNOWN', `A client's fix for invoice ${task.invoiceId}: FactorCloud didn't confirm attaching documents ${documentIds.join(', ')}. Check the invoice's documents in FactorCloud.`);
    return NextResponse.json({ error: 'FactorCloud didn\'t confirm it received your files. Your factor will check, so you don\'t need to send them again.' }, { status: 502 });
  }

  const hashes = await Promise.all(files.map((file) => hashFile(file)));
  const db = await pool().connect();
  try {
    await db.query('begin');
    const claimed = await db.query(`
      update client_tasks set status='DONE', resolved_at=now(), resolved_by_user_id=$2, response_note=$3
      where id=$1 and status='OPEN' returning submission_id, client_id
    `, [taskId, session.userId, note]);
    if (!claimed.rows[0]) {
      await db.query('rollback');
      return NextResponse.json({ error: 'This request was already answered.' }, { status: 409 });
    }
    const { rows: [{ next }] } = await db.query<{ next: number }>('select coalesce(max(source_index), -1) + 1 as next from submission_files where submission_id=$1', [task.submissionId]);
    for (const [i, file] of files.entries()) {
      await db.query(`
        insert into submission_files (id, submission_id, original_file_name, source_index, sha256, document_type, file_size_bytes)
        values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing
      `, [`file_${randomUUID()}`, task.submissionId, file.name, Number(next) + i, hashes[i], documentType.toLowerCase(), file.size]);
    }
    await db.query(`update submissions set updated_at=now() where id=$1`, [task.submissionId]);
    await db.query(`delete from recovery_items where id=$1`, [claimId]);
    await db.query(`
      insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data)
      values ($1,$2,$3,$4,$5,'FIX_SUBMITTED',$6::jsonb)
    `, [`audit_${randomUUID()}`, session.factorId, claimed.rows[0].client_id, task.submissionId, session.userId, JSON.stringify({ taskId, note, documentIds, files: files.map((f) => f.name) })]);
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    // The files are attached in FactorCloud; only the portal's record failed. Leave it for the factor.
    await settle('FIX_ATTACH_UNKNOWN', `A client's fix for invoice ${task.invoiceId}: documents ${documentIds.join(', ')} were attached in FactorCloud, but the portal could not record it. Mark the request answered.`);
    console.error('[client-task-fix] recording failed after attaching', err);
    return NextResponse.json({ error: 'Your files reached FactorCloud. Your factor will confirm, so you don\'t need to send them again.', documentIds }, { status: 500 });
  } finally {
    db.release();
  }

  return NextResponse.json({ ok: true, documentIds });
}
