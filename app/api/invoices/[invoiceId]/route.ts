import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { getCompany, getInvoice } from '@/lib/factorcloud';
import { currentPortalSession, resolveConfiguredClientId } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { databaseAuthEnabled } from '@/lib/session';
import { submissionDetailByInvoice } from '@/lib/submission-detail';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(_req: Request, context: { params: Promise<{ invoiceId: string }> }) {
  try {
    const { invoiceId } = await context.params;
    const clientId = await resolveConfiguredClientId();
    const raw = await getInvoice(invoiceId);
    const record = raw ? collectRiskInvoiceRecords(raw).find((invoice) => invoice.id === invoiceId && invoice.companyClientId === clientId) : undefined;
    if (!record) return NextResponse.json({ error: 'Invoice not found for this client.' }, { status: 404 });

    let debtor: { id: string; name: string; code: string | null; phone: string | null } | null = null;
    if (record.companyDebtorId) {
      try {
        const company = await getCompany(record.companyDebtorId);
        debtor = {
          id: record.companyDebtorId,
          name: company.companyName || company.compCode || record.companyDebtorId,
          code: company.compCode || null,
          phone: company.phone || null,
        };
      } catch {
        debtor = { id: record.companyDebtorId, name: record.companyDebtorId, code: null, phone: null };
      }
    }

    let workflow = null;
    if (databaseAuthEnabled()) {
      const session = await currentPortalSession();
      if (session) workflow = await submissionDetailByInvoice(session.factorId, clientId, invoiceId);
    }

    return NextResponse.json({
      invoice: record,
      debtor,
      workflow,
      source: {
        note: 'FactorCloud is the invoice system of record. Portal workflow history is shown when the invoice was submitted through this portal.',
      },
    });
  } catch (err) {
    return apiErrorResponse(err, 'invoice-detail', 502);
  }
}
