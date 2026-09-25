import { NextResponse } from 'next/server';
import { getCompany, getInvoice } from '@/lib/factorcloud';
import { requireFactorSession } from '@/lib/portal-auth';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { apiErrorResponse } from '@/lib/api-errors';
import { submissionDetailById } from '@/lib/submission-detail';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(_req: Request, context: { params: Promise<{ submissionId: string }> }) {
  try {
    const session = await requireFactorSession();
    const { submissionId } = await context.params;
    const submission = await submissionDetailById(session.factorId, submissionId);
    if (!submission) return NextResponse.json({ error: 'Submission not found.' }, { status: 404 });

    let invoice = null;
    if (submission.factorCloudInvoiceId) {
      try {
        const raw = await getInvoice(submission.factorCloudInvoiceId);
        invoice = raw && collectRiskInvoiceRecords(raw).find((record) =>
          record.id === submission.factorCloudInvoiceId && record.companyClientId === submission.factorCloudClientId,
        ) || null;
      } catch {
        invoice = null;
      }
    }

    let debtor = null;
    if (submission.debtorFactorCloudId) {
      try {
        const company = await getCompany(submission.debtorFactorCloudId);
        debtor = { id: submission.debtorFactorCloudId, name: company.companyName || company.compCode || submission.debtorFactorCloudId };
      } catch {
        debtor = { id: submission.debtorFactorCloudId, name: submission.debtorFactorCloudId };
      }
    }

    return NextResponse.json({
      submission,
      invoice,
      debtor,
      note: 'Portal review decisions are audited here. FactorCloud remains the invoice system of record, so portal approval or rejection does not yet change FactorCloud verification/funding status.',
    });
  } catch (err) {
    return apiErrorResponse(err, 'ops-submission');
  }
}
