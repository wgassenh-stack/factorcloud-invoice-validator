import { NextResponse } from 'next/server';
import { DEMO_DRIVER } from '@/lib/demo';
import { demoRequest } from '@/lib/demo-request';
import { demoDriverInvoices } from '@/lib/demo-store';
import { apiErrorResponse } from '@/lib/api-errors';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { adminDriverViewAllowed, requirePortalSession, resolveConfiguredClientId } from '@/lib/portal-auth';
import { driverRows, type PortalState } from '@/lib/pilot-views';
import { query } from '@/lib/db';
import { latestTasksBySubmission } from '@/lib/client-tasks';
import { databaseAuthEnabled } from '@/lib/session';
import { collectRiskInvoiceRecords } from '@/lib/risk';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * The Driver view's invoice list. With demo data: one demo driver's invoices. With admin views
 * (NEXT_PUBLIC_ADMIN_VIEWS=true): every invoice sent from the Driver view, since FactorCloud notes
 * say who sent each one. With database sign-in (factor staff only), the portal's review decisions
 * and fix requests are shown too. Real per-driver logins come later.
 */
export async function GET() {
  if (await demoRequest()) return NextResponse.json({ driver: DEMO_DRIVER, invoices: demoDriverInvoices(DEMO_DRIVER) });
  try {
    if (!(await adminDriverViewAllowed())) return NextResponse.json({ error: 'The Driver view is only available with demo data for now.' }, { status: 404 });
    const clientId = await resolveConfiguredClientId();
    const today = new Date().toISOString().slice(0, 10);
    let records = collectRiskInvoiceRecords((await listInvoices({ client: clientId })).raw);
    const signed=databaseAuthEnabled()?await requirePortalSession():null;
    if(signed?.role==='DRIVER'){
      const owned=await query<{factorcloud_invoice_id:string}>(`select factorcloud_invoice_id from submissions where factor_id=$1 and submitted_by_user_id=$2 and factorcloud_invoice_id is not null`,[signed.factorId,signed.userId]);
      const ids=new Set(owned.map(r=>r.factorcloud_invoice_id));
      records=records.filter(r=>ids.has(r.id));
    }
    let portal: Record<string, PortalState> = {};
    if (databaseAuthEnabled()) {
      try { portal = await portalStates((await requirePortalSession()).factorId, clientId, records.map((r) => r.id)); }
      catch (err) { console.error('[driver-invoices] portal review state unavailable', err); }
    }
    const rows = driverRows(records, clientId, today, portal);
    const debtorIds = [...new Set(rows.map((row) => row.debtorId).filter((id): id is string => Boolean(id)))];
    const names = Object.fromEntries(await Promise.all(debtorIds.map(async (id) => {
      try {
        const company = await getCompany(id);
        return [id, company.companyName || company.compCode || id] as const;
      } catch {
        return [id, 'Customer'] as const;
      }
    })));
    return NextResponse.json({
      driver: signed?.role==='DRIVER'?(signed.displayName||signed.email):null,
      invoices: rows.map(({ debtorId, ...row }) => ({ ...row, debtorName: debtorId ? names[debtorId] : 'Customer' })),
    });
  } catch (err) {
    return apiErrorResponse(err, 'driver-invoices');
  }
}

/** The portal's latest review and fix request for each invoice it sent. */
async function portalStates(factorId: string, clientId: string, invoiceIds: string[]): Promise<Record<string, PortalState>> {
  if (!invoiceIds.length) return {};
  const rows = await query<{ factorcloud_invoice_id: string; submission_id: string; review_status: string | null; decision_note: string | null }>(`
    select distinct on (s.factorcloud_invoice_id) s.factorcloud_invoice_id, s.id as submission_id,
      r.status as review_status, r.decision_note
    from submissions s
    join portal_clients c on c.id = s.client_id
    left join review_items r on r.submission_id = s.id
    where s.factor_id = $1 and c.factorcloud_client_id = $2 and s.factorcloud_invoice_id = any($3::text[])
    order by s.factorcloud_invoice_id, s.created_at desc, r.created_at desc nulls last
  `, [factorId, clientId, invoiceIds]);
  const tasks = await latestTasksBySubmission(rows.map((row) => row.submission_id));
  return Object.fromEntries(rows.map((row) => {
    const task = tasks[row.submission_id];
    const review = row.review_status === 'OPEN' || row.review_status === 'APPROVED' || row.review_status === 'REJECTED' ? row.review_status : null;
    return [row.factorcloud_invoice_id, {
      review,
      rejectionNote: review === 'REJECTED' ? row.decision_note : null,
      openFix: task?.status === 'OPEN' ? task.message : null,
      fixAnswered: task?.status === 'DONE',
      taskId: task?.status === 'OPEN' ? task.id : null,
    } satisfies PortalState];
  }));
}

