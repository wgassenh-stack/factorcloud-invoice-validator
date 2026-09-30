import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { listRuns, loadSettings } from '@/lib/funding-engine';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';
import {fundingSummary} from '@/lib/ops-funding';
import type {RunState} from '@/lib/funding-engine';
import { demoFundingData } from '@/lib/demo-funding';

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
    const lanes:Record<string,RunState[]>={decision:['APPROVED'],suggestions:['SUGGESTED'],exceptions:['FAILED','FUNDING'],funded:['FUNDED'],review:['REVIEW']};
    const lane=url.searchParams.get('lane');
    if(lane&&!lanes[lane])return NextResponse.json({error:'Unknown funding lane.'},{status:400});
    const createdAt=url.searchParams.get('before'),id=url.searchParams.get('beforeId');
    if((createdAt||id)&&(!createdAt||!id||!Number.isFinite(Date.parse(createdAt))||id.length>200))return NextResponse.json({error:'Invalid funding cursor.'},{status:400});
    const [settings, runs] = await Promise.all([loadSettings(session.factorId), listRuns(session.factorId,{states:lane?lanes[lane]:undefined,before:createdAt&&id?{createdAt,id}:undefined,limit:101})]);
    const summary=await fundingSummary(session.factorId);
    const shown=runs.slice(0,100),last=shown.at(-1);
    return NextResponse.json({ available: true, mode: settings.mode, runs:shown,summary,next:runs.length>100&&last?{createdAt:last.createdAt,id:last.id}:null, canAct: session.role === 'FACTOR_ADMIN' });
  } catch (err) {
    return apiErrorResponse(err, 'ops-funding');
  }
}
