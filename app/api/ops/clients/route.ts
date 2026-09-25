import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { averageInvoiceAmount, buildStatusMix, buildWeeklyActivity, periodAmount, trendPercent } from '@/lib/dashboard';
import { query } from '@/lib/db';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { summarizeClients } from '@/lib/ops';
import { requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';

export const runtime = 'nodejs';
export const maxDuration = 120;

type ReviewSummaryRow = {
  open_count: number | string;
  open_amount: number | string | null;
  oldest_created_at: Date | string | null;
};

export async function GET() {
  try {
    const session = await requireFactorSession();
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
    const clientNames = Object.fromEntries(names);

    const clients = summarizeClients(records, clientNames);
    const totalAmount = clients.reduce((sum, client) => sum + client.invoiceAmount, 0);
    const totalInvoices = clients.reduce((sum, client) => sum + client.invoiceCount, 0);
    const last30Amount = periodAmount(records, 30);
    const prior30Amount = periodAmount(records, 30, new Date(), 30);
    const topClient = [...clients].sort((a, b) => b.invoiceAmount - a.invoiceAmount)[0];

    let reviewSummary = { openCount: 0, openAmount: 0, oldestCreatedAt: null as string | null };
    try {
      const rows = await query<ReviewSummaryRow>(`
        select count(*)::int as open_count,
          coalesce(sum(s.invoice_amount_submitted), 0) as open_amount,
          min(r.created_at) as oldest_created_at
        from review_items r
        join submissions s on s.id = r.submission_id
        where s.factor_id = $1 and r.status = 'OPEN'
      `, [session.factorId]);
      const row = rows[0];
      reviewSummary = {
        openCount: Number(row?.open_count ?? 0),
        openAmount: Number(row?.open_amount ?? 0),
        oldestCreatedAt: row?.oldest_created_at ? new Date(row.oldest_created_at).toISOString() : null,
      };
    } catch (err) {
      console.error('[ops-clients] review summary unavailable', err);
    }

    const recentInvoices = records
      .slice()
      .sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? '')))
      .slice(0, 10)
      .map((record) => ({
        id: record.id,
        invoiceNumber: record.invoiceNumber,
        companyClientId: record.companyClientId,
        clientName: record.companyClientId ? clientNames[record.companyClientId] || record.companyClientId : 'Unknown client',
        invoiceAmount: record.invoiceAmount,
        invoiceDate: record.invoiceDate,
        status: record.status,
      }));

    return NextResponse.json({
      clients,
      totals: { clientCount: clients.length, invoiceCount: totalInvoices, invoiceAmount: totalAmount },
      portfolio: {
        weeklyActivity: buildWeeklyActivity(records, 12),
        statuses: buildStatusMix(records),
        averageInvoiceAmount: averageInvoiceAmount(records),
        last30Amount,
        prior30Amount,
        last30TrendPct: trendPercent(last30Amount, prior30Amount),
        topClientShare: topClient && totalAmount > 0 ? topClient.invoiceAmount / totalAmount : 0,
        recentInvoices,
        reviewSummary,
      },
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
