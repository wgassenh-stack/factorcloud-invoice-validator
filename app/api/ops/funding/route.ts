import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { listRuns, loadSettings } from '@/lib/funding-engine';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';
import {fundingSummary} from '@/lib/ops-funding';
import {LANE_SQL,type Lane} from '@/lib/funding-engine';
import { demoFundingData } from '@/lib/demo-funding';
import { syncWithFactorCloud } from '@/lib/factorcloud-sync';
import { effectiveModes } from '@/lib/rules/settings';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

/** What the funding engine decided and did, newest first. */
export async function GET(req:Request) {
  try {
    const session = await requireFactorSession();
    if (await demoRequest()) return NextResponse.json(demoFundingData(new URL(req.url).searchParams.get('lane')));
    if (!databaseAuthEnabled()) {
      return NextResponse.json({ available: false, mode: 'off', runs: [], canAct: false, note: 'The funding engine needs database sign-in.' });
    }
    const url=new URL(req.url);
    const lane=url.searchParams.get('lane');
    if(lane&&!(lane in LANE_SQL))return NextResponse.json({error:'Unknown funding lane.'},{status:400});
    const createdAt=url.searchParams.get('before'),id=url.searchParams.get('beforeId');
    if((createdAt||id)&&(!createdAt||!id||!Number.isFinite(Date.parse(createdAt))||id.length>200))return NextResponse.json({error:'Invalid funding cursor.'},{status:400});
    // Catch up with anything done in FactorCloud directly before listing.
    const sync = await syncWithFactorCloud(session.factorId, { force: url.searchParams.get('refresh') === '1' });
    const [settings, runs] = await Promise.all([loadSettings(session.factorId), listRuns(session.factorId,{lane:(lane as Lane)||undefined,before:createdAt&&id?{createdAt,id}:undefined,limit:101})]);
    const summary=await fundingSummary(session.factorId);
    const clientIds=await query<{id:string}>('select factorcloud_client_id as id from portal_clients where factor_id=$1 and is_active',[session.factorId]);
    const shown=runs.slice(0,100),last=shown.at(-1);
    return NextResponse.json({ available: true, mode: settings.mode, runs:shown,summary,next:runs.length>100&&last?{createdAt:last.createdAt,id:last.id}:null, canAct: session.role === 'FACTOR_ADMIN', sync, automation: { paused: settings.paused, defaultMode: settings.mode, clients: effectiveModes(settings, clientIds.map((c) => c.id)) } });
  } catch (err) {
    return apiErrorResponse(err, 'ops-funding');
  }
}
