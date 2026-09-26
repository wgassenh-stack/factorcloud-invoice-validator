import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { buildAging, buildExposure } from '@/lib/analytics';
import { buildDebtorSummaries } from '@/lib/debtors';
import { demoRequest } from '@/lib/demo-request';
import { getCompany, listInvoices } from '@/lib/factorcloud';
import { requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';

export const runtime = 'nodejs';
export const maxDuration = 120;

async function companyNames(ids: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(ids.map(async (id) => {
    try { const company = await getCompany(id); return [id, company.companyName || company.compCode || id] as const; }
    catch { return [id, id] as const; }
  }));
  return Object.fromEntries(entries);
}

/** Debtors across every client: exposure, age of what they owe, and how fast they pay. */
export async function GET() {
  try {
    await requireFactorSession();
    const list = await listInvoices();
    const records = collectRiskInvoiceRecords(list.raw);
    const today = new Date().toISOString().slice(0, 10);

    // Name lookups are one FactorCloud call each, so only for the debtors and clients shown.
    const firstPass = buildDebtorSummaries(records, today, { debtors: {}, clients: {} });
    const debtorIds = firstPass.slice(0, 80).map((d) => d.debtorId);
    const clientIds = [...new Set(records.map((r) => r.companyClientId).filter((id): id is string => Boolean(id)))].slice(0, 100);
    const [debtors, clients] = await Promise.all([companyNames(debtorIds), companyNames(clientIds)]);

    return NextResponse.json({
      today,
      debtors: buildDebtorSummaries(records, today, { debtors, clients }).slice(0, 80),
      aging: buildAging(records, debtors, today, 'debtor', 8),
      exposure: buildExposure(records, debtors, 'debtor', { review: 0.15, high: 0.25 }).slice(0, 30),
      complete: list.complete,
      incompleteReason: list.incompleteReason ?? null,
      demo: await demoRequest(),
    });
  } catch (err) {
    return apiErrorResponse(err, 'ops-debtors', 502);
  }
}
