import { NextResponse } from 'next/server';
import { fcRequest, getCompany } from '@/lib/factorcloud';
import { collectRiskInvoiceRecords, summarizeRisk, type RiskThresholds } from '@/lib/risk';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET() {
  const clientId = process.env.FACTORCLOUD_CLIENT_ID;
  if (!clientId) return NextResponse.json({ error: 'FACTORCLOUD_CLIENT_ID is not configured.' }, { status: 500 });

  try {
    const [raw, client] = await Promise.all([
      fcRequest('/invoices'),
      getCompany(clientId),
    ]);
    const allRecords = collectRiskInvoiceRecords(raw);
    const records = allRecords.filter((record) => !record.companyClientId || record.companyClientId === clientId);

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
    return NextResponse.json({
      ...summary,
      records,
      thresholds,
      source: {
        clientId,
        clientName: client.companyName || client.compCode || 'FactorCloud client',
        returnedInvoiceCount: allRecords.length,
        clientInvoiceCount: records.length,
        note: 'Pilot analytics use the invoice records returned by FactorCloud. API pagination and open-A/R status semantics still need to be confirmed before treating these as production exposure metrics.',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
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
