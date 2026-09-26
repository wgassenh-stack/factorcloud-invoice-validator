import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { requireFactorSession, resolveConfiguredClientId } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { buildStatement, statementMonths } from '@/lib/statements';
import { demoRequest } from '@/lib/demo-request';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * A client's statement for one month. Clients get their own; factor staff may pass `client` to see
 * any client's statement.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const requestedClient = url.searchParams.get('client');
    let clientId: string;
    if (requestedClient) {
      await requireFactorSession();
      clientId = requestedClient;
    } else {
      clientId = await resolveConfiguredClientId();
    }

    const today = new Date().toISOString().slice(0, 10);
    const months = statementMonths(today);
    const month = months.includes(url.searchParams.get('month') ?? '') ? url.searchParams.get('month')! : months[0];

    const [list, client] = await Promise.all([listInvoices({ client: clientId }), getCompany(clientId)]);
    const records = collectRiskInvoiceRecords(list.raw).filter((record) => record.companyClientId === clientId);
    const statement = buildStatement(records, month);

    const debtorIds = [...new Set(statement.lines.map((line) => line.debtorId).filter((id): id is string => Boolean(id)))].slice(0, 60);
    const debtorEntries = await Promise.all(debtorIds.map(async (id) => {
      try { const company = await getCompany(id); return [id, company.companyName || company.compCode || id] as const; }
      catch { return [id, id] as const; }
    }));

    return NextResponse.json({
      statement,
      months,
      client: { id: clientId, name: client.companyName || client.compCode || clientId },
      debtorNames: Object.fromEntries(debtorEntries),
      generatedAt: new Date().toISOString(),
      complete: list.complete,
      demo: await demoRequest(),
    });
  } catch (err) {
    return apiErrorResponse(err, 'statements', 502);
  }
}
