import { NextResponse } from 'next/server';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords, summarizeRisk, type RiskThresholds } from '@/lib/risk';
import { apiErrorResponse } from '@/lib/api-errors';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(_req: Request, context: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await context.params;
  if (!clientId) return NextResponse.json({ error: 'Client id is required.' }, { status: 400 });

  try {
    await requireFactorSession();
    const [list, client] = await Promise.all([listInvoices({ client: clientId }), getCompany(clientId)]);
    const allRecords = collectRiskInvoiceRecords(list.raw);
    const records = allRecords.filter((record) => record.companyClientId === clientId);
    const debtorIds = [...new Set(records.map((record) => record.companyDebtorId).filter((id): id is string => Boolean(id)))].slice(0, 50);
    const debtorEntries = await Promise.all(debtorIds.map(async (id) => {
      try { const debtor = await getCompany(id); return [id, debtor.companyName || debtor.compCode || id] as const; }
      catch { return [id, id] as const; }
    }));
    const debtorNames = Object.fromEntries(debtorEntries);

    const thresholds: RiskThresholds = {
      concentrationReview: percentEnv('RISK_CONCENTRATION_REVIEW_PCT', 30),
      concentrationHigh: percentEnv('RISK_CONCENTRATION_HIGH_PCT', 50),
      volumeSpikeRatio: numberEnv('RISK_VOLUME_SPIKE_RATIO', 1.5),
    };
    const summary = summarizeRisk(records, debtorNames, new Date().toISOString().slice(0, 10), thresholds);

    return NextResponse.json({
      client: {
        id: clientId,
        name: client.companyName || client.compCode || clientId,
        code: client.compCode || null,
        phone: client.phone || null,
        city: client.city || null,
        state: client.stateCode || null,
      },
      records,
      debtorNames,
      summary,
      source: {
        returnedInvoiceCount: allRecords.length,
        clientInvoiceCount: records.length,
        complete: list.complete,
        incompleteReason: list.incompleteReason ?? null,
        note: `${completenessNote(list)} Only invoices that positively match this FactorCloud client ID are included.`,
      },
    });
  } catch (err) {
    return apiErrorResponse(err, 'ops-client', 502);
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
