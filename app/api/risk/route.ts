import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { query } from '@/lib/db';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { resolveConfiguredClientId } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords, summarizeRisk, type RiskThresholds } from '@/lib/risk';
import { buildAging, buildCashSummary, buildDsoTrend } from '@/lib/analytics';
import { demoMode } from '@/lib/demo';
import { demoReviews } from '@/lib/demo-store';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 120;

type WorkflowRow = {
  factorcloud_invoice_id: string;
  workflow_status: string;
  validation_status: string;
  updated_at: Date | string;
};

export async function GET() {
  try {
    const clientId = await resolveConfiguredClientId();
    const [list, client] = await Promise.all([
      listInvoices({ client: clientId }),
      getCompany(clientId),
    ]);
    const allRecords = collectRiskInvoiceRecords(list.raw);
    const records = allRecords.filter((record) => record.companyClientId === clientId);

    const debtorIds = [...new Set(records.map((record) => record.companyDebtorId).filter((id): id is string => Boolean(id)))].slice(0, 50);
    const debtorEntries = await Promise.all(debtorIds.map(async (id) => {
      try {
        const company = await getCompany(id);
        return [id, company.companyName || company.compCode || id] as const;
      } catch {
        return [id, id] as const;
      }
    }));
    const debtorNames = Object.fromEntries(debtorEntries);

    const thresholds: RiskThresholds = {
      concentrationReview: percentEnv('RISK_CONCENTRATION_REVIEW_PCT', 30),
      concentrationHigh: percentEnv('RISK_CONCENTRATION_HIGH_PCT', 50),
      volumeSpikeRatio: numberEnv('RISK_VOLUME_SPIKE_RATIO', 1.5),
    };

    const today = new Date().toISOString().slice(0, 10);
    const summary = summarizeRisk(records, debtorNames, today, thresholds);
    const portalWorkflows: Record<string, { workflowStatus: string; validationStatus: string; updatedAt: string }> = {};

    if (demoMode()) {
      for (const review of demoReviews()) {
        if (review.clientId !== clientId) continue;
        portalWorkflows[review.invoiceId] = { workflowStatus: review.status === 'OPEN' ? 'REVIEW_REQUIRED' : review.status, validationStatus: 'REVIEW', updatedAt: review.decidedAt ?? review.createdAt };
      }
    } else if (databaseAuthEnabled() && records.length) {
      const invoiceIds = records.map((record) => record.id).filter(Boolean);
      if (invoiceIds.length) {
        const rows = await query<WorkflowRow>(`
          select s.factorcloud_invoice_id, s.workflow_status, s.validation_status, s.updated_at
          from submissions s
          join portal_clients pc on pc.id = s.client_id
          where pc.factorcloud_client_id = $1
            and s.factorcloud_invoice_id = any($2::text[])
          order by s.updated_at desc
        `, [clientId, invoiceIds]);

        for (const row of rows) {
          if (!row.factorcloud_invoice_id || portalWorkflows[row.factorcloud_invoice_id]) continue;
          portalWorkflows[row.factorcloud_invoice_id] = {
            workflowStatus: row.workflow_status,
            validationStatus: row.validation_status,
            updatedAt: new Date(row.updated_at).toISOString(),
          };
        }
      }
    }

    return NextResponse.json({
      ...summary,
      records,
      portalWorkflows,
      thresholds,
      cash: buildCashSummary(records, today),
      debtorAging: buildAging(records, debtorNames, today, 'debtor', 5),
      dso: buildDsoTrend(records, today, 6),
      debtorNames,
      demo: demoMode(),
      source: {
        clientId,
        clientName: client.companyName || client.compCode || 'FactorCloud client',
        returnedInvoiceCount: allRecords.length,
        clientInvoiceCount: records.length,
        excludedWithoutPositiveClientMatch: allRecords.length - records.length,
        complete: list.complete,
        incompleteReason: list.incompleteReason ?? null,
        note: `${completenessNote(list)} Only invoices whose FactorCloud client ID matches this client are shown. Open-A/R status semantics still need to be confirmed before treating these as exposure metrics.`,
      },
    });
  } catch (err) {
    return apiErrorResponse(err, 'risk', 502);
  }
}

function percentEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  const pct = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return pct / 100;
}

function numberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function completenessNote(list: { complete: boolean; incompleteReason?: string; pages: number }): string {
  return list.complete
    ? `Includes every matching FactorCloud invoice (${list.pages} page${list.pages === 1 ? '' : 's'} read).`
    : `These figures may be incomplete: ${list.incompleteReason ?? 'FactorCloud\'s invoice list could not be read to the end.'}`;
}
