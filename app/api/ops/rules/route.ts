import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { loadSettings, saveSettings } from '@/lib/funding-engine';
import { requireFactorSession } from '@/lib/portal-auth';
import { DEFAULT_SETTINGS } from '@/lib/rules/settings';
import { databaseAuthEnabled } from '@/lib/session';
import { query } from '@/lib/db';
import { demoFundingClients, demoFundingSettings, saveDemoFundingSettings } from '@/lib/demo-funding';

export const runtime = 'nodejs';

/** The funding engine's rules for this factor. */
export async function GET() {
  try {
    const session = await requireFactorSession();
    if (await demoRequest()) return NextResponse.json({ settings: demoFundingSettings(), clients: demoFundingClients(), editable: true, demo: true });
    if (!databaseAuthEnabled()) {
      return NextResponse.json({ settings: DEFAULT_SETTINGS, clients: [], editable: false, note: 'The funding engine needs database sign-in: these are the defaults.' });
    }
    const clients = await query<{ id: string; name: string }>('select factorcloud_client_id as id, name from portal_clients where factor_id = $1 order by name', [session.factorId]);
    return NextResponse.json({ settings: await loadSettings(session.factorId), clients, editable: session.role === 'FACTOR_ADMIN' });
  } catch (err) {
    return apiErrorResponse(err, 'ops-rules');
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireFactorSession();
    if (await demoRequest()) return NextResponse.json({ settings: saveDemoFundingSettings((await req.json().catch(() => null))?.settings) });
    if (!databaseAuthEnabled()) return NextResponse.json({ error: 'The funding engine needs database sign-in.' }, { status: 409 });
    if (session.role !== 'FACTOR_ADMIN') return NextResponse.json({ error: 'Only a factor admin can change the funding rules.' }, { status: 403 });
    const body = await req.json().catch(() => null);
    return NextResponse.json({ settings: await saveSettings(session.factorId, session.userId, body?.settings) });
  } catch (err) {
    return apiErrorResponse(err, 'ops-rules');
  }
}
