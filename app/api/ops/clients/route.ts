import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { buildAging, buildDailyVolume, buildDsoTrend, buildExposure, buildKpis, buildMonthlyCash } from '@/lib/analytics';
import { averageInvoiceAmount, buildStatusMix, buildWeeklyActivity, periodAmount, trendPercent } from '@/lib/dashboard';
import { query } from '@/lib/db';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { summarizeClients } from '@/lib/ops';
import { pilotAdminViews, requireFactorSession } from '@/lib/portal-auth';
import { cleanArrivals, flaggedForReview, sentAt as recordSentAt } from '@/lib/pilot-views';
import { readPortalNote } from '@/lib/portal-notes';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { demoArrivalsToday, demoReviews, type Arrival } from '@/lib/demo-store';
import { demoRequest } from '@/lib/demo-request';

export const runtime = 'nodejs';
export const maxDuration = 120;

type ReviewSummaryRow = {
  open_count: number | string;
  open_amount: number | string | null;
  oldest_created_at: Date | string | null;
};

type ArrivalRow = {
  id: string;
  factorcloud_invoice_id: string;
  invoice_number_submitted: string | null;
  factorcloud_client_id: string;
  invoice_amount_submitted: number | string | null;
  document_count: number | string;
  submitted_by: string | null;
  created_at: Date | string;
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
    const today = new Date().toISOString().slice(0, 10);
    const topClient = [...clients].sort((a, b) => b.invoiceAmount - a.invoiceAmount)[0];

    // "Unavailable" is never shown as zero: an empty queue and a queue we couldn't read are different.
    let reviewSummary = { available: false, openCount: 0, openAmount: 0, oldestCreatedAt: null as string | null };
    const pilot = !(await demoRequest()) && pilotAdminViews();
    if (pilot) {
      // No portal database: flagged invoices are read from the portal's note on each invoice.
      const open = flaggedForReview(records);
      reviewSummary = {
        available: true,
        openCount: open.length,
        openAmount: open.reduce((sum, record) => sum + (record.invoiceAmount ?? 0), 0),
        oldestCreatedAt: open[0] ? recordSentAt(open[0]) || null : null,
      };
    } else if (await demoRequest()) {
      const open = demoReviews().filter((review) => review.status === 'OPEN');
      reviewSummary = {
        available: true,
        openCount: open.length,
        openAmount: open.reduce((sum, review) => sum + review.invoiceAmount, 0),
        oldestCreatedAt: open.map((review) => review.createdAt).sort()[0] ?? null,
      };
    } else try {
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
        available: true,
        openCount: Number(row?.open_count ?? 0),
        openAmount: Number(row?.open_amount ?? 0),
        oldestCreatedAt: row?.oldest_created_at ? new Date(row.oldest_created_at).toISOString() : null,
      };
    } catch (err) {
      console.error('[ops-clients] review summary unavailable', err);
    }

    // Invoices that passed every check and went straight into FactorCloud today: nothing for the
    // portal's review queue, but the factor still decides on funding in FactorCloud.
    let arrivals: Arrival[] | null = null;
    if (await demoRequest()) arrivals = demoArrivalsToday();
    else if (pilot) arrivals = cleanArrivals(records, today).map((record) => ({
      submissionId: null,
      invoiceId: record.id,
      invoiceNumber: record.invoiceNumber,
      clientId: record.companyClientId ?? '',
      invoiceAmount: record.invoiceAmount,
      documentCount: null,
      submittedBy: readPortalNote(record.notes).sentBy,
      createdAt: recordSentAt(record),
    }));
    else try {
      const rows = await query<ArrivalRow>(`
        select s.id, s.factorcloud_invoice_id, s.invoice_number_submitted, c.factorcloud_client_id,
          s.invoice_amount_submitted, s.created_at,
          coalesce(u.display_name, u.email) as submitted_by,
          (select count(*) from submission_files f where f.submission_id = s.id)::int as document_count
        from submissions s
        join portal_clients c on c.id = s.client_id
        left join portal_users u on u.id = s.submitted_by_user_id
        where s.factor_id = $1 and s.validation_status = 'PASS' and s.workflow_status = 'CREATED_IN_FACTORCLOUD'
          and s.factorcloud_invoice_id is not null and s.created_at >= date_trunc('day', now())
        order by s.created_at desc
        limit 50
      `, [session.factorId]);
      arrivals = rows.map((row) => ({
        submissionId: row.id,
        invoiceId: row.factorcloud_invoice_id,
        invoiceNumber: row.invoice_number_submitted,
        clientId: row.factorcloud_client_id,
        invoiceAmount: row.invoice_amount_submitted == null ? null : Number(row.invoice_amount_submitted),
        documentCount: Number(row.document_count),
        submittedBy: row.submitted_by,
        createdAt: new Date(row.created_at).toISOString(),
      }));
    } catch (err) {
      console.error('[ops-clients] arrivals unavailable', err);
    }
    const statusById = new Map(records.map((record) => [record.id, record.status]));
    const arrivedToday = {
      available: arrivals != null,
      count: arrivals?.length ?? 0,
      amount: (arrivals ?? []).reduce((sum, a) => sum + (a.invoiceAmount ?? 0), 0),
      items: (arrivals ?? []).slice(0, 8).map((a) => ({
        ...a,
        clientName: clientNames[a.clientId] || a.clientId,
        status: statusById.get(a.invoiceId) ?? null,
      })),
    };

    const recentInvoices = records
      .slice()
      // Same-day ties: the later entry in FactorCloud's list (added more recently) comes first.
      .reverse()
      .sort((a, b) => sentAt(b).localeCompare(sentAt(a)))
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
        arrivedToday,
      },
      analytics: {
        today,
        kpis: buildKpis(records, today),
        aging: buildAging(records, clientNames, today),
        exposure: buildExposure(records, clientNames).slice(0, 24),
        monthlyCash: buildMonthlyCash(records, today),
        dso: buildDsoTrend(records, today),
        daily: buildDailyVolume(records, today),
      },
      demo: (await demoRequest()),
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

/** When an invoice was sent in (FactorCloud's created time), so "latest" means most recently sent. */
function sentAt(record: { createdOn?: string | null; invoiceDate?: string | null }): string {
  return String(record.createdOn ?? record.invoiceDate ?? '');
}
