import { NextResponse } from 'next/server';
import { resolveConfiguredClientId } from '@/lib/portal-auth';
import { verifyDocumentsReceipt } from '@/lib/submission-integrity';
import { apiErrorResponse } from '@/lib/api-errors';
import { groupingProblem } from '@/lib/paperwork-grouping';
import { checkCards } from '@/lib/paperwork';

export const runtime = 'nodejs';

/**
 * Re-checks an upload after someone moved documents between groups. Uses the signed copy of what
 * was read, so nothing is read twice and nothing read can be changed on the way back.
 */
export async function POST(req: Request) {
  try {
    const clientId = await resolveConfiguredClientId();
    const body = await req.json().catch(() => null) as { documentsReceipt?: string; cards?: { id?: unknown; documentIndexes?: unknown }[] } | null;
    if (!body?.documentsReceipt || !Array.isArray(body.cards)) return NextResponse.json({ error: 'Missing upload or grouping.' }, { status: 400 });
    const receipt = verifyDocumentsReceipt(body.documentsReceipt);
    if (receipt.clientId !== clientId) return NextResponse.json({ error: 'This upload belongs to a different client.' }, { status: 403 });

    const groups = body.cards.map((card, i) => ({
      id: typeof card.id === 'string' && /^[\w-]{1,40}$/.test(card.id) ? card.id : `card-${i + 1}`,
      documentIndexes: Array.isArray(card.documentIndexes) ? card.documentIndexes as number[] : [],
    }));
    const problem = groupingProblem(groups.map((g) => g.documentIndexes), receipt.documents.length);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const { cards, warnings } = await checkCards(clientId, receipt.documents, groups);
    return NextResponse.json({ cards, warnings });
  } catch (err) {
    return apiErrorResponse(err, 'paperwork-check');
  }
}
