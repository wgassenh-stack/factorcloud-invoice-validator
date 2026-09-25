import 'server-only';

import { query } from './db';

type SubmissionRow = {
  id: string;
  factorcloud_invoice_id: string | null;
  invoice_number_original: string | null;
  invoice_number_submitted: string | null;
  reference_number_original: string | null;
  reference_number_submitted: string | null;
  debtor_factorcloud_id: string | null;
  invoice_amount_original: string | number | null;
  invoice_amount_submitted: string | number | null;
  invoice_date_original: string | Date | null;
  invoice_date_submitted: string | Date | null;
  validation_status: string;
  workflow_status: string;
  created_at: string | Date;
  updated_at: string | Date;
  factorcloud_client_id: string;
  client_name: string;
  submitted_by_email: string | null;
  submitted_by_name: string | null;
};

type FileRow = {
  id: string;
  original_file_name: string;
  source_index: number;
  sha256: string;
  document_type: string | null;
  file_size_bytes: string | number | null;
  created_at: string | Date;
};

type ReviewRow = {
  id: string;
  status: string;
  reason: string;
  decision_note: string | null;
  created_at: string | Date;
  decided_at: string | Date | null;
  decided_by_email: string | null;
  decided_by_name: string | null;
};

type AuditRow = {
  id: string;
  event_type: string;
  event_data: unknown;
  created_at: string | Date;
  actor_email: string | null;
  actor_name: string | null;
};

export type PortalSubmissionDetail = {
  id: string;
  factorCloudInvoiceId: string | null;
  factorCloudClientId: string;
  clientName: string;
  debtorFactorCloudId: string | null;
  validationStatus: string;
  workflowStatus: string;
  createdAt: string;
  updatedAt: string;
  submittedBy: { email: string | null; name: string | null };
  original: {
    invoiceNumber: string | null;
    referenceNumber: string | null;
    invoiceAmount: number | null;
    invoiceDate: string | null;
  };
  submitted: {
    invoiceNumber: string | null;
    referenceNumber: string | null;
    invoiceAmount: number | null;
    invoiceDate: string | null;
  };
  files: Array<{
    id: string;
    fileName: string;
    sourceIndex: number;
    sha256: string;
    documentType: string | null;
    fileSizeBytes: number | null;
    createdAt: string;
  }>;
  reviews: Array<{
    id: string;
    status: string;
    reason: string;
    decisionNote: string | null;
    createdAt: string;
    decidedAt: string | null;
    decidedBy: { email: string | null; name: string | null };
  }>;
  audit: Array<{
    id: string;
    eventType: string;
    eventData: unknown;
    createdAt: string;
    actor: { email: string | null; name: string | null };
  }>;
};

export async function submissionDetailByInvoice(
  factorId: string,
  factorCloudClientId: string,
  invoiceId: string,
): Promise<PortalSubmissionDetail | null> {
  const rows = await query<SubmissionRow>(`
    select s.id, s.factorcloud_invoice_id, s.invoice_number_original, s.invoice_number_submitted,
      s.reference_number_original, s.reference_number_submitted, s.debtor_factorcloud_id,
      s.invoice_amount_original, s.invoice_amount_submitted, s.invoice_date_original, s.invoice_date_submitted,
      s.validation_status, s.workflow_status, s.created_at, s.updated_at,
      c.factorcloud_client_id, c.name as client_name,
      u.email as submitted_by_email, u.display_name as submitted_by_name
    from submissions s
    join portal_clients c on c.id = s.client_id
    left join portal_users u on u.id = s.submitted_by_user_id
    where s.factor_id = $1 and c.factorcloud_client_id = $2 and s.factorcloud_invoice_id = $3
    order by s.created_at desc
    limit 1
  `, [factorId, factorCloudClientId, invoiceId]);
  return rows[0] ? hydrate(rows[0]) : null;
}

export async function submissionDetailById(factorId: string, submissionId: string): Promise<PortalSubmissionDetail | null> {
  const rows = await query<SubmissionRow>(`
    select s.id, s.factorcloud_invoice_id, s.invoice_number_original, s.invoice_number_submitted,
      s.reference_number_original, s.reference_number_submitted, s.debtor_factorcloud_id,
      s.invoice_amount_original, s.invoice_amount_submitted, s.invoice_date_original, s.invoice_date_submitted,
      s.validation_status, s.workflow_status, s.created_at, s.updated_at,
      c.factorcloud_client_id, c.name as client_name,
      u.email as submitted_by_email, u.display_name as submitted_by_name
    from submissions s
    join portal_clients c on c.id = s.client_id
    left join portal_users u on u.id = s.submitted_by_user_id
    where s.factor_id = $1 and s.id = $2
    limit 1
  `, [factorId, submissionId]);
  return rows[0] ? hydrate(rows[0]) : null;
}

async function hydrate(row: SubmissionRow): Promise<PortalSubmissionDetail> {
  const [files, reviews, audit] = await Promise.all([
    query<FileRow>(`
      select id, original_file_name, source_index, sha256, document_type, file_size_bytes, created_at
      from submission_files where submission_id = $1 order by source_index
    `, [row.id]),
    query<ReviewRow>(`
      select r.id, r.status, r.reason, r.decision_note, r.created_at, r.decided_at,
        u.email as decided_by_email, u.display_name as decided_by_name
      from review_items r
      left join portal_users u on u.id = r.decided_by_user_id
      where r.submission_id = $1
      order by r.created_at desc
    `, [row.id]),
    query<AuditRow>(`
      select a.id, a.event_type, a.event_data, a.created_at,
        u.email as actor_email, u.display_name as actor_name
      from audit_events a
      left join portal_users u on u.id = a.actor_user_id
      where a.submission_id = $1
      order by a.created_at desc
    `, [row.id]),
  ]);

  return {
    id: row.id,
    factorCloudInvoiceId: row.factorcloud_invoice_id,
    factorCloudClientId: row.factorcloud_client_id,
    clientName: row.client_name,
    debtorFactorCloudId: row.debtor_factorcloud_id,
    validationStatus: row.validation_status,
    workflowStatus: row.workflow_status,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    submittedBy: { email: row.submitted_by_email, name: row.submitted_by_name },
    original: {
      invoiceNumber: row.invoice_number_original,
      referenceNumber: row.reference_number_original,
      invoiceAmount: numberOrNull(row.invoice_amount_original),
      invoiceDate: dateOnly(row.invoice_date_original),
    },
    submitted: {
      invoiceNumber: row.invoice_number_submitted,
      referenceNumber: row.reference_number_submitted,
      invoiceAmount: numberOrNull(row.invoice_amount_submitted),
      invoiceDate: dateOnly(row.invoice_date_submitted),
    },
    files: files.map((file) => ({
      id: file.id,
      fileName: file.original_file_name,
      sourceIndex: file.source_index,
      sha256: file.sha256,
      documentType: file.document_type,
      fileSizeBytes: numberOrNull(file.file_size_bytes),
      createdAt: iso(file.created_at)!,
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      status: review.status,
      reason: review.reason,
      decisionNote: review.decision_note,
      createdAt: iso(review.created_at)!,
      decidedAt: iso(review.decided_at),
      decidedBy: { email: review.decided_by_email, name: review.decided_by_name },
    })),
    audit: audit.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      eventData: event.event_data,
      createdAt: iso(event.created_at)!,
      actor: { email: event.actor_email, name: event.actor_name },
    })),
  };
}

function numberOrNull(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: string | Date | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function dateOnly(value: string | Date | null): string | null {
  const valueIso = iso(value);
  return valueIso ? valueIso.slice(0, 10) : null;
}
