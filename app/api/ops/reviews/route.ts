import { NextResponse } from 'next/server';
import { fcRequest, getCompany } from '@/lib/factorcloud';
import { collectRiskInvoiceRecords } from '@/lib/risk';

export const runtime = 'nodejs';
export const maxDuration = 120;

const REVIEW_MARKER = 'PORTAL REVIEW REQUIRED';

export async function GET() {
  try {
    const raw = await fcRequest('/invoices');
    const records = collectRiskInvoiceRecords(raw)
      .filter((record) => (record.notes || '').toUpperCase().includes(REVIEW_MARKER))
      .sort((a, b) => String(b.invoiceDate ?? '').localeCompare(String(a.invoiceDate ?? '')));

    const clientIds = [...new Set(records.map((record) => record.companyClientId).filter((id): id is string => Boolean(id)))].slice(0, 50);
    const debtorIds = [...new Set(records.map((record) => record.companyDebtorId).filter((id): id is string => Boolean(id)))].slice(0, 50);

    const [clients, debtors] = await Promise.all([
      Promise.all(clientIds.map(async (id) => {
        try {
          const company = await getCompany(id);
          return [id, company.companyName || company.compCode || id] as const;
        } catch {
          return [id, id] as const;
        }
      })),
      Promise.all(debtorIds.map(async (id) => {
        try {
          const company = await getCompany(id);
          return [id, company.companyName || company.compCode || id] as const;
        } catch {
          return [id, id] as const;
        }
      })),
    ]);

    return NextResponse.json({
      records,
      clientNames: Object.fromEntries(clients),
      debtorNames: Object.fromEntries(debtors),
      source: {
        marker: REVIEW_MARKER,
        note: 'V1 review queue is derived from the explicit portal review marker written into FactorCloud invoice notes. A database-backed workflow will replace this with assignment, decisions, comments, and audit history.',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
