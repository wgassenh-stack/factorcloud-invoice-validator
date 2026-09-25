import { NextResponse } from 'next/server';
import { fcRequest, getCompany } from '@/lib/factorcloud';
import { summarizeClients } from '@/lib/ops';
import { requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET() {
  try {
    if (databaseAuthEnabled()) await requireFactorSession();
    const raw = await fcRequest('/invoices');
    const records = collectRiskInvoiceRecords(raw);
    const clientIds = [...new Set(records.map((record) => record.companyClientId).filter((id): id is string => Boolean(id)))];

    const names = await Promise.all(clientIds.slice(0, 100).map(async (id) => {
      try {
        const company = await getCompany(id);
        return [id, company.companyName || company.compCode || id] as const;
      } catch {
        return [id, id] as const;
      }
    }));

    const clients = summarizeClients(records, Object.fromEntries(names));
    const totalAmount = clients.reduce((sum, client) => sum + client.invoiceAmount, 0);
    const totalInvoices = clients.reduce((sum, client) => sum + client.invoiceCount, 0);

    return NextResponse.json({
      clients,
      totals: { clientCount: clients.length, invoiceCount: totalInvoices, invoiceAmount: totalAmount },
      source: {
        returnedInvoiceCount: records.length,
        note: 'This V1 admin view groups the invoice records returned by FactorCloud. It is not yet a guaranteed complete list of every client because FactorCloud invoice pagination and a dedicated client-list endpoint still need to be confirmed.',
      },
    });
  } catch (err) {
    const status = (err as { status?: number }).status || 502;
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status });
  }
}
