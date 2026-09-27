import { NextResponse } from 'next/server';
import { resolveConfiguredClientId } from '@/lib/portal-auth';
import { signDocumentsReceipt, verifyDocumentsReceipt } from '@/lib/submission-integrity';
import { apiErrorResponse } from '@/lib/api-errors';
import { groupingProblem } from '@/lib/paperwork-grouping';
import { checkCards, readFiles, uploadProblem } from '@/lib/paperwork';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * "+ Add a document" on an invoice card: reads only the new files, adds them to that card (or as a
 * new invoice), and re-checks everything. Returns a new signed copy of all documents read so far.
 */
export async function POST(req: Request) {
  try {
    const clientId = await resolveConfiguredClientId();
    const form = await req.formData();
    const receipt = verifyDocumentsReceipt(String(form.get('documentsReceipt') ?? ''));
    if (receipt.clientId !== clientId) return NextResponse.json({ error: 'This upload belongs to a different client.' }, { status: 403 });

    const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
    const problem = uploadProblem(files, receipt.documents.length);
    if (problem) return NextResponse.json({ error: problem.message }, { status: problem.status });

    const firstIndex = Number(form.get('firstIndex'));
    if (!Number.isInteger(firstIndex) || firstIndex < 0 || firstIndex > 200) return NextResponse.json({ error: 'Missing file position.' }, { status: 400 });

    let groups: { id: string; documentIndexes: number[] }[];
    try {
      const parsed = JSON.parse(String(form.get('cards') ?? '[]')) as { id?: unknown; documentIndexes?: unknown }[];
      groups = parsed.map((card, i) => ({
        id: typeof card.id === 'string' && /^[\w-]{1,40}$/.test(card.id) ? card.id : `card-${i + 1}`,
        documentIndexes: Array.isArray(card.documentIndexes) ? card.documentIndexes as number[] : [],
      })).filter((g) => g.documentIndexes.length);
    } catch {
      return NextResponse.json({ error: 'The grouping could not be read.' }, { status: 400 });
    }
    if (groups.length) {
      const bad = groupingProblem(groups.map((g) => g.documentIndexes), receipt.documents.length);
      if (bad) return NextResponse.json({ error: bad }, { status: 400 });
    }
    const target = String(form.get('target') ?? 'new');

    const read = await readFiles(files, firstIndex, receipt.documents.map((d) => d.fileHash ?? ''));
    const documents = [...receipt.documents, ...read.documents];
    const added = read.documents.map((_, i) => receipt.documents.length + i);
    if (added.length) {
      const card = groups.find((g) => g.id === target);
      if (card) card.documentIndexes = [...card.documentIndexes, ...added];
      else groups.push({ id: `card-a${Date.now().toString(36)}`, documentIndexes: added });
    }

    const { cards, warnings } = await checkCards(clientId, documents, groups);
    return NextResponse.json({ documents, documentsReceipt: signDocumentsReceipt(clientId, documents), cards, added, unreadable: read.unreadable, duplicates: read.duplicates, warnings });
  } catch (err) {
    return apiErrorResponse(err, 'paperwork-add');
  }
}
