import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { apiErrorResponse } from '@/lib/api-errors';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { pilotAdminViews, requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { flaggedForReview, sentAt } from '@/lib/pilot-views';
import { readPortalNote } from '@/lib/portal-notes';
import { EXPLANATION_CHECK_ID } from '@/lib/override';
import { demoCompany, demoLatestTask, demoReviews } from '@/lib/demo-store';
import { latestTasksBySubmission, type ClientTask } from '@/lib/client-tasks';
import { demoRequest } from '@/lib/demo-request';

export const runtime = 'nodejs';
export const maxDuration = 120;

type DbReviewRow = {
  review_id: string;
  submission_id: string;
  factorcloud_invoice_id: string | null;
  invoice_number_submitted: string | null;
  debtor_factorcloud_id: string | null;
  invoice_amount_submitted: string | number | null;
  invoice_date_submitted: string | null;
  workflow_status: string;
  review_status: string;
  reason: string;
  created_at: Date | string;
  client_id: string;
  factorcloud_client_id: string;
  client_name: string;
};

export async function GET() {
  try {
    const session = await requireFactorSession();
    if (await demoRequest()) return NextResponse.json(demoReviewList());
    if (pilotAdminViews()) return NextResponse.json(await pilotReviewList());
    const rows = await query<DbReviewRow>(`
      select r.id as review_id, r.submission_id, s.factorcloud_invoice_id, s.invoice_number_submitted,
        s.debtor_factorcloud_id, s.invoice_amount_submitted, s.invoice_date_submitted, s.workflow_status,
        r.status as review_status, r.reason, r.created_at, c.id as client_id, c.factorcloud_client_id, c.name as client_name
      from review_items r
      join submissions s on s.id = r.submission_id
      join portal_clients c on c.id = s.client_id
      where s.factor_id = $1 and r.status = 'OPEN'
      order by r.created_at desc
    `, [session.factorId]);

    const debtorIds = [...new Set(rows.map((row) => row.debtor_factorcloud_id).filter((id): id is string => Boolean(id)))].slice(0, 50);
    const debtorEntries = await Promise.all(debtorIds.map(async (id) => {
      try {
        const company = await getCompany(id);
        return [id, company.companyName || company.compCode || id] as const;
      } catch {
        return [id, id] as const;
      }
    }));

    let tasks: Record<string, ClientTask> = {};
    try { tasks = await latestTasksBySubmission(rows.map((row) => row.submission_id)); }
    catch (err) { console.error('[ops-reviews] fix requests unavailable', err); }

    const records = rows.map((row) => ({
      id: row.factorcloud_invoice_id || row.submission_id,
      reviewId: row.review_id,
      submissionId: row.submission_id,
      invoiceNumber: row.invoice_number_submitted,
      companyClientId: row.factorcloud_client_id,
      companyDebtorId: row.debtor_factorcloud_id,
      invoiceAmount: row.invoice_amount_submitted == null ? null : Number(row.invoice_amount_submitted),
      invoiceDate: row.invoice_date_submitted ? String(row.invoice_date_submitted).slice(0, 10) : null,
      status: row.workflow_status,
      reviewStatus: row.review_status,
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
      fix: fixSummary(tasks[row.submission_id]),
    }));

    return NextResponse.json({
      records,
      clientNames: Object.fromEntries(rows.map((row) => [row.factorcloud_client_id, row.client_name])),
      debtorNames: Object.fromEntries(debtorEntries),
      source: { note: 'Review items are stored in the portal database with assignment-ready workflow state and audit history. FactorCloud remains the invoice system of record.' },
    });
  } catch (err) {
    return apiErrorResponse(err, 'ops-reviews');
  }
}

function demoReviewList() {
  const open = demoReviews().filter((review) => review.status === 'OPEN');
  return {
    records: open.map((review) => ({
      id: review.invoiceId,
      reviewId: review.reviewId,
      submissionId: review.submissionId,
      invoiceNumber: review.invoiceNumber,
      companyClientId: review.clientId,
      companyDebtorId: review.debtorId,
      invoiceAmount: review.invoiceAmount,
      invoiceDate: review.invoiceDate,
      status: 'REVIEW_REQUIRED',
      reviewStatus: review.status,
      reason: review.reason,
      createdAt: review.createdAt,
      checks: review.checks,
      fix: fixSummary(demoLatestTask(review.submissionId), demoLatestTask(review.submissionId)?.files.length),
    })),
    clientNames: Object.fromEntries(open.map((review) => [review.clientId, review.clientName])),
    debtorNames: Object.fromEntries(open.map((review) => [review.debtorId, demoCompany(review.debtorId)?.companyName ?? review.debtorId])),
    source: { note: 'Demo data. Review decisions are kept in memory for this demo only.' },
  };
}

/**
 * Without the portal database: invoices the portal flagged, read from its note on each FactorCloud
 * invoice. Read only. The factor approves, rejects or asks for a fix in FactorCloud.
 */
async function pilotReviewList() {
  const records = flaggedForReview(collectRiskInvoiceRecords((await listInvoices()).raw));
  const ids = [...new Set(records.flatMap((r) => [r.companyClientId, r.companyDebtorId]).filter((id): id is string => Boolean(id)))].slice(0, 60);
  const names = Object.fromEntries(await Promise.all(ids.map(async (id) => {
    try {
      const company = await getCompany(id);
      return [id, company.companyName || company.compCode || id] as const;
    } catch {
      return [id, id] as const;
    }
  })));
  return {
    records: records.map((record) => {
      const note = readPortalNote(record.notes);
      return {
        id: record.id,
        invoiceNumber: record.invoiceNumber,
        companyClientId: record.companyClientId,
        companyDebtorId: record.companyDebtorId,
        invoiceAmount: record.invoiceAmount,
        invoiceDate: record.invoiceDate ? record.invoiceDate.slice(0, 10) : null,
        status: record.status,
        reason: `Flagged by the portal's checks${note.sentBy ? ` · sent by ${note.sentBy === 'Driver' ? 'a driver' : 'the office'}` : ''}`,
        createdAt: sentAt(record).includes('T') ? sentAt(record) : undefined,
        checks: note.clientNote ? [{ id: EXPLANATION_CHECK_ID, label: "Client's note", status: 'REVIEW' as const, message: note.clientNote }] : [],
        fix: null,
      };
    }),
    clientNames: Object.fromEntries(records.flatMap((r) => r.companyClientId ? [[r.companyClientId, names[r.companyClientId] ?? r.companyClientId]] : [])),
    debtorNames: Object.fromEntries(records.flatMap((r) => r.companyDebtorId ? [[r.companyDebtorId, names[r.companyDebtorId] ?? r.companyDebtorId]] : [])),
    readOnly: true,
    source: { note: 'Invoices the portal flagged that are still waiting in FactorCloud. Approve, reject or ask for a fix in FactorCloud: this shared-password setup has no portal database to record decisions.' },
  };
}

/** What the queue needs to know about a fix request: waiting on the client, or answered. */
function fixSummary(task: Pick<ClientTask, 'status' | 'message' | 'createdAt' | 'resolvedAt' | 'responseNote'> | null | undefined, fileCount?: number) {
  if (!task || task.status === 'CANCELED') return null;
  return { status: task.status, message: task.message, requestedAt: task.createdAt, answeredAt: task.resolvedAt, responseNote: task.responseNote, fileCount: fileCount ?? null };
}
