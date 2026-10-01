import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { actOnRun, batchFor, listRuns, removeRun } from '@/lib/funding-engine';
import { actOnDemoRun, demoRun, removeDemoRun } from '@/lib/demo-funding';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** A person's click: "approve" a suggestion for funding, "fund" an approved invoice, or "remove" it from the list. Factor admins only. */
export async function POST(req: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireFactorSession();
    if (await demoRequest()) {
      const { runId } = await context.params;
      const body = await req.json().catch(() => ({})) as { action?: string };
      if (body.action === 'remove') { const result = removeDemoRun(runId, 'Demo Admin'); return NextResponse.json({ ...result, run: demoRun(runId) }, { status: result.ok ? 200 : 409 }); }
      if (body.action !== 'approve' && body.action !== 'fund') return NextResponse.json({ error: 'Choose approve or fund.' }, { status: 400 });
      const result = actOnDemoRun(runId, body.action, 'Demo Admin');
      return NextResponse.json({ ...result, run: demoRun(runId) }, { status: result.ok ? 200 : 409 });
    }
    if (!databaseAuthEnabled()) return NextResponse.json({ error: 'The funding engine needs database sign-in.' }, { status: 409 });
    if (session.role !== 'FACTOR_ADMIN') return NextResponse.json({ error: 'Only a factor admin can approve, fund or remove invoices.' }, { status: 403 });
    const { runId } = await context.params;
    const body = await req.json().catch(() => ({})) as { action?: string; expected?: unknown; seenHolds?: unknown };
    if (body.action === 'remove') {
      const result = await removeRun(session.factorId, runId, session.userId, session.displayName || session.email);
      return NextResponse.json({ ...result, run: (await listRuns(session.factorId, { id: runId }))[0] ?? null }, { status: result.ok ? 200 : 409 });
    }
    if (body.action !== 'approve' && body.action !== 'fund') return NextResponse.json({ error: 'Choose approve or fund.' }, { status: 400 });
    const result = await actOnRun(session.factorId, runId, body.action, session.userId, session.displayName || session.email, reviewed(body));
    const [run] = await listRuns(session.factorId, { id: runId });
    return NextResponse.json({ ...result, run: run ?? null }, { status: result.ok ? 200 : 409 });
  } catch (err) {
    return apiErrorResponse(err, 'ops-funding-action');
  }
}

/**
 * What funding this invoice would pay: its FactorCloud batch and everything in it. Shown in the
 * confirm dialog, because FactorCloud funds the whole batch.
 */
export async function GET(_req: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requireFactorSession();
    const { runId } = await context.params;
    if (await demoRequest()) {
      const run = demoRun(runId);
      if (!run) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
      return NextResponse.json({ batch: { groupId: run.invoiceGroupId, code: null, status: 'NOT_FUNDED', invoices: [{ runId: run.id, invoiceId: run.factorCloudInvoiceId, invoiceNumber: run.invoiceNumber, clientName: run.clientName, amount: run.amount, state: run.state, outcome: run.outcome, mode: run.mode }] } });
    }
    if (!databaseAuthEnabled()) return NextResponse.json({ error: 'The funding engine needs database sign-in.' }, { status: 409 });
    const [run] = await listRuns(session.factorId, { id: runId });
    if (!run) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    if (run.state !== 'APPROVED') return NextResponse.json({ batch: null });
    return NextResponse.json({ batch: await batchFor(session.factorId, run.factorCloudInvoiceId, run.invoiceGroupId) });
  } catch (err) {
    return apiErrorResponse(err, 'ops-funding-batch');
  }
}

/** What the person reviewed in the dialog: the batch's invoices and the hold reasons shown. */
function reviewed(body: { expected?: unknown; seenHolds?: unknown }) {
  const expected = Array.isArray(body.expected)
    ? body.expected.slice(0, 500).flatMap((i) => i && typeof i === 'object' && typeof (i as { invoiceId?: unknown }).invoiceId === 'string'
      ? [{ invoiceId: (i as { invoiceId: string }).invoiceId, amount: typeof (i as { amount?: unknown }).amount === 'number' ? (i as { amount: number }).amount : null }] : [])
    : undefined;
  const seenHolds = Array.isArray(body.seenHolds) ? body.seenHolds.filter((id): id is string => typeof id === 'string').slice(0, 50) : undefined;
  return { expected, seenHolds };
}
