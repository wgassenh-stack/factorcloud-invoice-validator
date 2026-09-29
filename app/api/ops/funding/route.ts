import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { listRuns, loadSettings } from '@/lib/funding-engine';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';

/** What the funding engine decided and did, newest first. */
export async function GET() {
  try {
    const session = await requireFactorSession();
    if (await demoRequest() || !databaseAuthEnabled()) {
      return NextResponse.json({ available: false, mode: 'off', runs: [], canAct: false, note: 'The funding engine needs database sign-in.' });
    }
    const [settings, runs] = await Promise.all([loadSettings(session.factorId), listRuns(session.factorId)]);
    return NextResponse.json({ available: true, mode: settings.mode, runs, canAct: session.role === 'FACTOR_ADMIN' });
  } catch (err) {
    return apiErrorResponse(err, 'ops-funding');
  }
}
