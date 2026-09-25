import { NextResponse } from 'next/server';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { summarizeClients } from '@/lib/ops';
import { requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { apiErrorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET() {
  try {
    await requireFactorSession();
    const list = await listInvoices();
    const records = collectRiskInvoiceRecords(list.raw);
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
        complete: list.complete,
        incompleteReason: list.incompleteReason ?? null,
        note: `${completenessNote(list)} Clients appear here once they have at least one invoice.`,
      },
    });
  } catch (err) {
    return apiErrorResponse(err, 'ops-clients', 502);
  }
}

function completenessNote(list: { complete: boolean; incompleteReason?: string; pages: number }): string {
  return list.complete
    ? `Includes every matching FactorCloud invoice (${list.pages} page${list.pages === 1 ? '' : 's'} read).`
    : `These figures may be incomplete: ${list.incompleteReason ?? 'FactorCloud\'s invoice list could not be read to the end.'}`;
}
