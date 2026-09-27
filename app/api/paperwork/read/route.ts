import { NextResponse } from 'next/server';
import { extractDocument, isSupportedFile } from '@/lib/extract';
import { resolveConfiguredClientId } from '@/lib/portal-auth';
import { addFileIntegrity, assertReceiptSigningConfigured, signDocumentsReceipt } from '@/lib/submission-integrity';
import { apiErrorResponse } from '@/lib/api-errors';
import { groupPaperwork } from '@/lib/paperwork-grouping';
import { checkCards, type PaperworkResponse } from '@/lib/paperwork';
import type { AnalyzedDocument } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_FILES = 24;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const READ_CONCURRENCY = 4;

/**
 * Reads every uploaded document once, sorts them into one group per invoice and checks each group.
 * Handles one invoice's paperwork and a whole stack of invoices the same way.
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
  if (!files.length) return NextResponse.json({ error: 'Add at least one document or photo.' }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Send at most ${MAX_FILES} documents at a time.` }, { status: 400 });
  if (files.some((f) => f.size > MAX_FILE_BYTES)) return NextResponse.json({ error: 'Each file must be 10 MB or smaller.' }, { status: 413 });
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) return NextResponse.json({ error: 'All files together must be 25 MB or smaller.' }, { status: 413 });
  const unsupported = files.filter((f) => !isSupportedFile(f.type));
  if (unsupported.length) return NextResponse.json({ error: `Unsupported file type: ${unsupported.map((f) => f.name).join(', ')}. Use PDF, PNG, JPEG, GIF or WebP.` }, { status: 400 });

  // Which camera load each photo was taken in (the "Next load" button). Only a grouping hint.
  let loads: (number | null)[] = [];
  try {
    const parsed = JSON.parse(String(form.get('loads') ?? '[]'));
    if (Array.isArray(parsed)) loads = parsed.map((v) => (Number.isInteger(v) ? v : null));
  } catch { /* no hints */ }

  let extracted: AnalyzedDocument[];
  try {
    extracted = await mapLimit(files, READ_CONCURRENCY, async (file) => {
      const result = await extractDocument(file);
      return { fileName: file.name, fields: result.fields, usage: result.usage };
    });
  } catch (err) {
    return NextResponse.json({ error: `Every file must be read before the paperwork can be checked. ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }

  try {
    const documents = await addFileIntegrity(files, extracted);
    const grouping = groupPaperwork(documents, loads);
    const { cards, warnings } = await checkCards(clientId, documents, grouping.groups.map((documentIndexes, i) => ({ id: `card-${i + 1}`, documentIndexes })));
    if (!grouping.groups.length) warnings.push('No invoice was found. Add the invoice, or put these documents in a new group and type the invoice details.');
    const body: PaperworkResponse = { documents, documentsReceipt: signDocumentsReceipt(clientId, documents), cards, unassigned: grouping.unassigned, warnings };
    return NextResponse.json(body);
  } catch (err) {
    return apiErrorResponse(err, 'paperwork-read');
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}
