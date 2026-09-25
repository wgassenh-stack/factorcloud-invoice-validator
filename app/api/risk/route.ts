import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { query } from '@/lib/db';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { resolveConfiguredClientId } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords, summarizeRisk, type RiskThresholds } from '@/lib/risk';
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
    const [{ raw }, client] = await Promise.all([
      listInvoices(),
      getCompany(clientId),
    ]);
    const allRecords = collectRiskInvoiceRecords(raw);
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

    const summary = summarizeRisk(records, debtorNames, new Date().toISOString().slice(0, 10), thresholds);
    const portalWorkflows: Record<string, { workflowStatus: string; validationStatus: string; updatedAt: string }> = {};

    if (databaseAuthEnabled() && records.length) {
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
      source: {
        clientId,
        clientName: client.companyName || client.compCode || 'FactorCloud client',
        returnedInvoiceCount: allRecords.length,
        clientInvoiceCount: records.length,
        excludedWithoutPositiveClientMatch: allRecords.length - records.length,
        note: 'Client-facing data requires an explicit FactorCloud client ID match. Records without a matching client ID are excluded. API pagination and open-A/R status semantics still need to be confirmed before treating these as production exposure metrics.',
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
