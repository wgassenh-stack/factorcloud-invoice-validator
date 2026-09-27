import { NextResponse } from 'next/server';
import { resolveConfiguredClientId } from '@/lib/portal-auth';
import { assertReceiptSigningConfigured, signDocumentsReceipt } from '@/lib/submission-integrity';
import { apiErrorResponse } from '@/lib/api-errors';
import { groupPaperwork, suggestPlacements } from '@/lib/paperwork-grouping';
import { checkCards, readFiles, uploadProblem, type PaperworkResponse } from '@/lib/paperwork';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Reads every uploaded document once, sorts them into one group per invoice and checks each group.
 * Handles one invoice's paperwork and a whole stack of invoices the same way. A file that can't be
 * read, or the same file uploaded twice, is reported and left out; the rest carries on.
 */
export async function POST(req: Request) {
  let clientId: string;
  try {
    clientId = await resolveConfiguredClientId();
    assertReceiptSigningConfigured();
  } catch (err) {
    return apiErrorResponse(err, 'paperwork-read');
  }

  const form = await req.formData();
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  const problem = uploadProblem(files);
  if (problem) return NextResponse.json({ error: problem.message }, { status: problem.status });

  // Which camera load each photo was taken in (the "Next load" button). Only a grouping hint.
  let loads: (number | null)[] = [];
  try {
    const parsed = JSON.parse(String(form.get('loads') ?? '[]'));
    if (Array.isArray(parsed)) loads = parsed.map((v) => (Number.isInteger(v) ? v : null));
  } catch { /* no hints */ }

  try {
    const read = await readFiles(files, 0);
    const { documents } = read;
    if (!documents.length) return NextResponse.json({ error: 'None of the files could be read. Retake the photos or upload clearer copies.' }, { status: 422 });
    const docLoads = read.fileIndexes.map((i) => loads[i] ?? null);
    const grouping = groupPaperwork(documents, docLoads);
    const { cards, warnings } = await checkCards(clientId, documents, grouping.groups.map((documentIndexes, i) => ({ id: `card-${i + 1}`, documentIndexes })));
    if (!grouping.groups.length) warnings.push('No invoice was found. Add the invoice, or make one of these its own invoice and type the details.');
    const body: PaperworkResponse = {
      documents,
      documentsReceipt: signDocumentsReceipt(clientId, documents),
      cards,
      unassigned: grouping.unassigned,
      suggestions: suggestPlacements(documents, grouping.groups, grouping.unassigned, docLoads),
      unreadable: read.unreadable,
      duplicates: read.duplicates,
      warnings,
    };
    return NextResponse.json(body);
  } catch (err) {
    return apiErrorResponse(err, 'paperwork-read');
  }
}
