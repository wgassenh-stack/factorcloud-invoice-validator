import 'server-only';

import { createHash, randomUUID } from 'crypto';
import { pool } from './db';
import { normalizeIdentifier } from './normalize';
import { portalClientRecord, type PortalAccessError } from './portal-auth';
import { databaseAuthEnabled, type PortalSession } from './session';
import type { AnalysisReceiptPayload } from './submission-integrity';
import type { ValidationReport } from './types';

export interface StoredSubmission {
  id: string;
  portalClientId: string;
}

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

    if (args.validation.status === 'REVIEW') {
      const reasons = args.validation.checks.filter((check) => check.status === 'REVIEW').map((check) => `${check.label}: ${check.message}`);
      await client.query(`insert into review_items (id, submission_id, reason) values ($1,$2,$3)`, [
        `review_${randomUUID()}`,
        submissionId,
        reasons.join(' | ') || 'Portal validation requires manual review.',
      ]);
    }

    await client.query(`
      insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data)
      values ($1,$2,$3,$4,$5,$6,$7::jsonb)
    `, [
      `audit_${randomUUID()}`,
      args.session.factorId,
      portalClient.id,
      submissionId,
      args.session.userId,
      'SUBMISSION_RECEIVED',
      JSON.stringify({ validationStatus: args.validation.status, invoiceNumber: args.invoiceNumber }),
    ]);

    await client.query('commit');
    return { id: submissionId, portalClientId: portalClient.id };
  } catch (err) {
    await client.query('rollback');
    const code = (err as { code?: string }).code;
    if (code === '23505') throw new Error('This invoice is already being processed or was already submitted through the portal.');
    throw err;
  } finally {
    client.release();
  }
}

export async function markSubmissionFactorCloudResult(args: {
  submission: StoredSubmission | null;
  session: PortalSession | null;
  invoiceId?: string | null;
  validationStatus: ValidationReport['status'];
  error?: string | null;
}): Promise<void> {
  if (!args.submission || !args.session || !databaseAuthEnabled()) return;
  const status = args.error ? 'ERROR' : args.validationStatus === 'REVIEW' ? 'REVIEW_REQUIRED' : 'CREATED_IN_FACTORCLOUD';
  await pool().query('update submissions set factorcloud_invoice_id=$1, workflow_status=$2, updated_at=now() where id=$3', [args.invoiceId ?? null, status, args.submission.id]);
  await pool().query(`
    insert into audit_events (id, factor_id, client_id, submission_id, actor_user_id, event_type, event_data)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb)
  `, [
    `audit_${randomUUID()}`,
    args.session.factorId,
    args.submission.portalClientId,
    args.submission.id,
    args.session.userId,
    args.error ? 'FACTORCLOUD_CREATE_FAILED' : 'FACTORCLOUD_INVOICE_CREATED',
    JSON.stringify({ invoiceId: args.invoiceId ?? null, error: args.error ?? null }),
  ]);
}
