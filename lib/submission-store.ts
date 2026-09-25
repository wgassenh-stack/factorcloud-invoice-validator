import 'server-only';

import { createHash, randomUUID } from 'crypto';
import { pool } from './db';
import { ensureSecuritySchema } from './schema';
import { PublicError } from './errors';
import { normalizeIdentifier } from './normalize';
import { portalClientRecord } from './portal-auth';
import { databaseAuthEnabled, type PortalSession } from './session';
import type { AnalysisReceiptPayload } from './submission-integrity';
import type { ValidationReport } from './types';

export interface StoredSubmission {
  id: string;
  portalClientId: string;
}

/** The invoice already has a portal submission that blocks a new one. */
export class SubmissionConflictError extends PublicError {
  constructor(message: string) {
    super(message, 409);
  }
}

/**
 * Suffix that releases a submission's idempotency key. Only applied after FactorCloud definitively
 * refused the create, so no invoice exists and the client may submit the same invoice again.
 */
export const RELEASED_KEY_MARKER = ':released:';

export async function persistSubmissionStart(args: {
  session: PortalSession | null;
  factorCloudClientId: string;
  receipt: AnalysisReceiptPayload;
  validation: ValidationReport;
  invoiceNumber: string;
  referenceNumber: string | null;
  invoiceAmount: number;
  invoiceDate: string;
  analysisReceipt: string;
  files: File[];
}): Promise<StoredSubmission | null> {
  if (!databaseAuthEnabled()) return null;
  if (!args.session) throw new Error('Authenticated portal session is required for database workflow.');

  const portalClient = await portalClientRecord(args.session.factorId, args.factorCloudClientId);
  if (!portalClient) throw new Error('Signed-in client is not configured in the portal database.');

  const submissionId = `sub_${randomUUID()}`;
  const idempotencyKey = createHash('sha256')
    .update(`${args.session.factorId}:${portalClient.id}:${normalizeIdentifier(args.invoiceNumber)}`)
    .digest('hex');
  const original = args.receipt.documents[args.receipt.primaryIndex].fields;
  const workflowStatus = args.validation.status === 'REVIEW' ? 'REVIEW_REQUIRED' : 'SUBMITTED';
  const client = await pool().connect();

  try {
    await client.query('begin');
    await client.query(`
      insert into submissions (
        id, factor_id, client_id, submitted_by_user_id, invoice_number_original, invoice_number_submitted,
        reference_number_original, reference_number_submitted, debtor_factorcloud_id,
        invoice_amount_original, invoice_amount_submitted, invoice_date_original, invoice_date_submitted,
        validation_status, workflow_status, analysis_receipt, idempotency_key
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    `, [
      submissionId,
      args.session.factorId,
      portalClient.id,
      args.session.userId,
      original.invoiceNumber,
      args.invoiceNumber,
      original.referenceNumber,
      args.referenceNumber,
      args.receipt.debtorId,
      original.invoiceAmount,
      args.invoiceAmount,
      original.invoiceDate || null,
      args.invoiceDate,
      args.validation.status,
      workflowStatus,
      args.analysisReceipt,
      idempotencyKey,
    ]);

    for (let i = 0; i < args.receipt.documents.length; i++) {
      const document = args.receipt.documents[i];
      const file = args.files[i];
      await client.query(`
        insert into submission_files (id, submission_id, original_file_name, source_index, sha256, document_type, file_size_bytes)
        values ($1,$2,$3,$4,$5,$6,$7)
      `, [`file_${randomUUID()}`, submissionId, document.fileName, i, document.fileHash, document.fields.documentType, file?.size ?? null]);
    }

    let reviewId: string | null = null;
    if (args.validation.status === 'REVIEW') {
      const reasons = args.validation.checks.filter((check) => check.status === 'REVIEW').map((check) => `${check.label}: ${check.message}`);
      reviewId = `review_${randomUUID()}`;
      await client.query(`insert into review_items (id, submission_id, reason) values ($1,$2,$3)`, [
        reviewId,
        submissionId,
        reasons.join(' | ') || 'Portal validation requires manual review.',
      ]);
    }

    await insertAudit(client, {
      factorId: args.session.factorId,
      clientId: portalClient.id,
      submissionId,
      actorUserId: args.session.userId,
      eventType: 'SUBMISSION_RECEIVED',
      eventData: {
        validationStatus: args.validation.status,
        invoiceNumber: args.invoiceNumber,
        checks: args.validation.checks.map((check) => ({ id: check.id, label: check.label, status: check.status, message: check.message })),
      },
    });

    if (reviewId) {
      await insertAudit(client, {
        factorId: args.session.factorId,
        clientId: portalClient.id,
        submissionId,
        actorUserId: args.session.userId,
        eventType: 'REVIEW_OPENED',
        eventData: { reviewId },
      });
    }

    await client.query('commit');
    return { id: submissionId, portalClientId: portalClient.id };
  } catch (err) {
    await client.query('rollback');
    const code = (err as { code?: string }).code;
    if (code === '23505') throw await conflictFor(idempotencyKey, err);
    throw err;
  } finally {
    client.release();
  }
}

async function conflictFor(idempotencyKey: string, err: unknown): Promise<Error> {
  const rows = (await pool().query<{ workflow_status: string; factorcloud_invoice_id: string | null }>(
    'select workflow_status, factorcloud_invoice_id from submissions where idempotency_key = $1',
    [idempotencyKey],
  )).rows;
  const existing = rows[0];
  if (!existing) {
    // Not the invoice-level key: the same file was included twice in one packet.
    if ((err as { constraint?: string }).constraint?.includes('sha256')) {
      return new PublicError('The same file appears more than once in this packet. Remove the duplicate and verify again.', 400);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
  if (existing.workflow_status === 'ERROR' && !existing.factorcloud_invoice_id) {
    return new SubmissionConflictError('A previous attempt to submit this invoice ended without a clear result from FactorCloud. Your factor needs to confirm in FactorCloud whether it was created before it can be submitted again.');
  }
  return new SubmissionConflictError('This invoice is already being processed or was already submitted through the portal.');
}

export async function markSubmissionFactorCloudResult(args: {
  submission: StoredSubmission | null;
  session: PortalSession | null;
  invoiceId?: string | null;
  validationStatus: ValidationReport['status'];
  error?: string | null;
  /**
   * Set only when FactorCloud definitively refused the create (no invoice exists). Releases the
   * idempotency key so the client can retry. Uncertain failures keep the key and block retries,
   * because the invoice may exist in FactorCloud.
   */
  retryable?: boolean;
}): Promise<void> {
  if (!args.submission || !args.session || !databaseAuthEnabled()) return;
  const status = args.error ? 'ERROR' : args.validationStatus === 'REVIEW' ? 'REVIEW_REQUIRED' : 'CREATED_IN_FACTORCLOUD';
  const release = Boolean(args.error && args.retryable && !args.invoiceId);
  await ensureSecuritySchema();
  await pool().query(`
    update submissions
    set factorcloud_invoice_id=$1, workflow_status=$2, updated_at=now(),
      idempotency_key = case when $4 then idempotency_key || $5 || id else idempotency_key end,
      idempotency_released_at = case when $4 then now() else idempotency_released_at end
    where id=$3
  `, [args.invoiceId ?? null, status, args.submission.id, release, RELEASED_KEY_MARKER]);
  await recordSubmissionAudit({
    submission: args.submission,
    session: args.session,
    eventType: args.error ? 'FACTORCLOUD_CREATE_FAILED' : 'FACTORCLOUD_INVOICE_CREATED',
    eventData: { invoiceId: args.invoiceId ?? null, error: args.error ?? null, ...(args.error ? { retryAllowed: release } : {}) },
  });
}

export async function recordSubmissionAudit(args: {
  submission: StoredSubmission | null;
  session: PortalSession | null;
  eventType: string;
  eventData?: Record<string, unknown>;
}): Promise<void> {
  if (!args.submission || !args.session || !databaseAuthEnabled()) return;
  await pool().query(`
    insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [
    `audit_${randomUUID()}`,
    args.session.factorId,
    args.submission.portalClientId,
    args.submission.id,
    args.session.userId,
    args.eventType,
    JSON.stringify(args.eventData ?? {}),
  ]);
}

async function insertAudit(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  args: { factorId: string; clientId: string; submissionId: string; actorUserId: string | null; eventType: string; eventData?: Record<string, unknown> },
) {
  await client.query(`
    insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [
    `audit_${randomUUID()}`,
    args.factorId,
    args.clientId,
    args.submissionId,
    args.actorUserId,
    args.eventType,
    JSON.stringify(args.eventData ?? {}),
  ]);
}
