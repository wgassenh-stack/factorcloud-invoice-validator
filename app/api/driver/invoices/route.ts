import { NextResponse } from 'next/server';
import { DEMO_DRIVER } from '@/lib/demo';
import { demoRequest } from '@/lib/demo-request';
import { demoDriverInvoices } from '@/lib/demo-store';
import { apiErrorResponse } from '@/lib/api-errors';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { pilotAdminViews, resolveConfiguredClientId } from '@/lib/portal-auth';
import { driverRows } from '@/lib/pilot-views';
import { collectRiskInvoiceRecords } from '@/lib/risk';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * The Driver view's invoice list. With demo data: one demo driver's invoices. With admin views on
 * a shared-password test environment: every invoice sent from the Driver view (FactorCloud notes
 * say who sent each one). Real per-driver logins come later with database sign-in.
 */
export async function GET() {
  if (await demoRequest()) return NextResponse.json({ driver: DEMO_DRIVER, invoices: demoDriverInvoices(DEMO_DRIVER) });
  if (!pilotAdminViews()) return NextResponse.json({ error: 'The Driver view is only available with demo data for now.' }, { status: 404 });
  try {
    const clientId = await resolveConfiguredClientId();
    const today = new Date().toISOString().slice(0, 10);
    const rows = driverRows(collectRiskInvoiceRecords((await listInvoices({ client: clientId })).raw), clientId, today);
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
      driver: null,
      invoices: rows.map(({ debtorId, ...row }) => ({ ...row, debtorName: debtorId ? names[debtorId] : 'Customer' })),
    });
  } catch (err) {
    return apiErrorResponse(err, 'driver-invoices');
  }
}
