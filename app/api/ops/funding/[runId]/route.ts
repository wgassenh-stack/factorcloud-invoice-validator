import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { actOnRun, listRuns } from '@/lib/funding-engine';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** A person's click: "approve" a suggestion for funding, or "fund" an approved invoice. Factor admins only. */
export async function POST(req: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireFactorSession();
    if (await demoRequest() || !databaseAuthEnabled()) return NextResponse.json({ error: 'The funding engine needs database sign-in.' }, { status: 409 });
    if (session.role !== 'FACTOR_ADMIN') return NextResponse.json({ error: 'Only a factor admin can approve or fund invoices.' }, { status: 403 });
    const { runId } = await context.params;
    const body = await req.json().catch(() => ({})) as { action?: string };
    if (body.action !== 'approve' && body.action !== 'fund') return NextResponse.json({ error: 'Choose approve or fund.' }, { status: 400 });
    const result = await actOnRun(session.factorId, runId, body.action, session.userId, session.displayName || session.email);
    const [run] = await listRuns(session.factorId, { id: runId });
    return NextResponse.json({ ...result, run: run ?? null }, { status: result.ok ? 200 : 409 });
  } catch (err) {
    return apiErrorResponse(err, 'ops-funding-action');
  }
}
