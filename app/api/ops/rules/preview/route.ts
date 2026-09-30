import { NextResponse } from 'next/server';
import { requireFactorSession } from '@/lib/portal-auth';
import { demoRequest } from '@/lib/demo-request';
import { databaseAuthEnabled } from '@/lib/session';
import { query } from '@/lib/db';
import { apiErrorResponse } from '@/lib/api-errors';
import { decide,type EngineFacts } from '@/lib/rules/engine';
import { normalizeSettings, settingsForClient } from '@/lib/rules/settings';

export async function POST(req:Request){
  try{
    const session=await requireFactorSession();
    if(await demoRequest()||!databaseAuthEnabled())return NextResponse.json({error:'Rule previews require saved database decisions.'},{status:409});
    const body=await req.json();const settings=normalizeSettings(body.settings);
    const rows=await query<{id:string;invoice_number:string;outcome:string;facts_snapshot:EngineFacts|null}>(`select id,invoice_number,outcome,facts_snapshot from engine_runs where factor_id=$1 order by created_at desc limit 100`,[session.factorId]);
    const results=rows.filter(r=>r.facts_snapshot).map(r=>{
      const facts={...r.facts_snapshot!,now:new Date(r.facts_snapshot!.now)};
      const result=decide(facts,settingsForClient(settings,facts.invoice.clientId));return {id:r.id,invoice:r.invoice_number,before:r.outcome,after:result.outcome,reasons:result.reasons};
    });
    return NextResponse.json({results,skipped:rows.length-results.length,note:'Uses facts recorded at each decision. This is not a live credit check or a simulation of future cumulative funding.'});
  }catch(err){return apiErrorResponse(err,'rules-preview');}
}

export async function GET(){
  try{const session=await requireFactorSession();if(await demoRequest()||!databaseAuthEnabled())return NextResponse.json({versions:[]});
    return NextResponse.json({versions:await query('select id,settings,created_at,actor_id from rule_versions where factor_id=$1 order by id desc limit 30',[session.factorId])});
  }catch(err){return apiErrorResponse(err,'rule-history');}
}
