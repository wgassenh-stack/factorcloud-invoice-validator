import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { loadSettings, saveSettings } from '@/lib/funding-engine';
import { requireFactorSession } from '@/lib/portal-auth';
import { DEFAULT_SETTINGS } from '@/lib/rules/settings';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';

/** The funding engine's rules for this factor. */
export async function GET() {
  try {
    const session = await requireFactorSession();
    if (await demoRequest() || !databaseAuthEnabled()) {
      return NextResponse.json({ settings: DEFAULT_SETTINGS, editable: false, note: 'The funding engine needs database sign-in: these are the defaults.' });
    }
    return NextResponse.json({ settings: await loadSettings(session.factorId), editable: session.role === 'FACTOR_ADMIN' });
  } catch (err) {
    return apiErrorResponse(err, 'ops-rules');
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireFactorSession();
    if (await demoRequest() || !databaseAuthEnabled()) return NextResponse.json({ error: 'The funding engine needs database sign-in.' }, { status: 409 });
    if (session.role !== 'FACTOR_ADMIN') return NextResponse.json({ error: 'Only a factor admin can change the funding rules.' }, { status: 403 });
    const body = await req.json().catch(() => null);
    return NextResponse.json({ settings: await saveSettings(session.factorId, session.userId, body?.settings) });
  } catch (err) {
    return apiErrorResponse(err, 'ops-rules');
  }
}
