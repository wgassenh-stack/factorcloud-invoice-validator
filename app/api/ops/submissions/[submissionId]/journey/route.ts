import {NextResponse} from 'next/server';
import {requireFactorSession} from '@/lib/portal-auth';
import {databaseAuthEnabled} from '@/lib/session';
import {demoRequest} from '@/lib/demo-request';
import {query} from '@/lib/db';
import {apiErrorResponse} from '@/lib/api-errors';
export async function GET(_req:Request,context:{params:Promise<{submissionId:string}>}){
  try{const s=await requireFactorSession();if(await demoRequest()||!databaseAuthEnabled())return NextResponse.json({events:[]});const {submissionId}=await context.params;
    if(!(await query('select id from submissions where id=$1 and factor_id=$2',[submissionId,s.factorId])).length)return NextResponse.json({error:'Not found'},{status:404});
    const events=await query(`select id,event_type as title,event_data as detail,created_at as at from audit_events where submission_id=$1 and factor_id=$2
      union all select id,'Funding: '||state,jsonb_build_object('detail',detail,'reasons',reasons,'rules',rules,'settings',settings_snapshot),updated_at from engine_runs where submission_id=$1 and factor_id=$2
      union all select id,'Recovery: '||status,jsonb_build_object('detail',detail,'resolution',resolution),coalesce(resolved_at,created_at) from recovery_items where submission_id=$1 and factor_id=$2
      order by at asc`,[submissionId,s.factorId]);return NextResponse.json({events});
  }catch(e){return apiErrorResponse(e,'invoice-journey');}
}
