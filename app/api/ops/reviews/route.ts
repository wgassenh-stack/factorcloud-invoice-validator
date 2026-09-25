import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { fcRequest, getCompany } from '@/lib/factorcloud';
import { requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 120;

const REVIEW_MARKER = 'PORTAL REVIEW REQUIRED';

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
  client_id: string;
  factorcloud_client_id: string;
  client_name: string;
};

export async function GET() {
  if (databaseAuthEnabled()) return databaseQueue();
  return legacyQueue();
}

async function databaseQueue() {
  try {
    const session = await requireFactorSession();
    const rows = await query<DbReviewRow>(`
      select r.id as review_id, r.submission_id, s.factorcloud_invoice_id, s.invoice_number_submitted,
        s.debtor_factorcloud_id, s.invoice_amount_submitted, s.invoice_date_submitted, s.workflow_status,
        r.status as review_status, r.reason, c.id as client_id, c.factorcloud_client_id, c.name as client_name
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
    }));

    return NextResponse.json({
      records,
      clientNames: Object.fromEntries(rows.map((row) => [row.factorcloud_client_id, row.client_name])),
      debtorNames: Object.fromEntries(debtorEntries),
      source: { note: 'Review items are stored in the portal database with assignment-ready workflow state and audit history. FactorCloud remains the invoice system of record.' },
    });
  } catch (err) {
    const status = (err as { status?: number }).status || 500;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}

async function legacyQueue() {
  try {
    const raw = await fcRequest('/invoices');
    const records = collectRiskInvoiceRecords(raw)
      .filter((record) => (record.notes || '').toUpperCase().includes(REVIEW_MARKER))
      .sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? '')));

    const clientIds = [...new Set(records.map((record) => record.companyClientId).filter((id): id is string => Boolean(id)))].slice(0, 50);
    const debtorIds = [...new Set(records.map((record) => record.companyDebtorId).filter((id): id is string => Boolean(id)))].slice(0, 50);
    const [clients, debtors] = await Promise.all([
      Promise.all(clientIds.map(async (id) => {
        try { const company = await getCompany(id); return [id, company.companyName || company.compCode || id] as const; }
        catch { return [id, id] as const; }
      })),
      Promise.all(debtorIds.map(async (id) => {
        try { const company = await getCompany(id); return [id, company.companyName || company.compCode || id] as const; }
        catch { return [id, id] as const; }
      })),
    ]);
    return NextResponse.json({
      records,
      clientNames: Object.fromEntries(clients),
      debtorNames: Object.fromEntries(debtors),
      source: { marker: REVIEW_MARKER, note: 'Pilot review queue is derived from the explicit portal review marker written into FactorCloud invoice notes.' },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
