import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';
import { demoRequest } from '@/lib/demo-request';
import { pool } from '@/lib/db';
import { recoveryQueue } from '@/lib/recovery';
import { apiErrorResponse } from '@/lib/api-errors';

export async function GET() {
  try {
    const session=await requireFactorSession();
    if (await demoRequest() || !databaseAuthEnabled()) return NextResponse.json({items:[],editable:false,note:'Recovery requires database sign-in.'});
    return NextResponse.json({items:await recoveryQueue(session.factorId),editable:session.role==='FACTOR_ADMIN'});
  } catch(err) {return apiErrorResponse(err,'recovery');}
}

export async function POST(req:Request) {
  try {
    const session=await requireFactorSession();
    if (await demoRequest() || !databaseAuthEnabled() || session.role!=='FACTOR_ADMIN') return NextResponse.json({error:'A database factor admin must reconcile this item.'},{status:403});
    const body=await req.json();
    if(typeof body.id!=='string' || typeof body.evidence!=='string' || body.evidence.trim().length<15 || body.evidence.length>2000 || !['repaired','funded','not-funded'].includes(body.outcome)) return NextResponse.json({error:'Choose an outcome and record what you verified in FactorCloud (15–2000 characters).'},{status:400});
    const db=await pool().connect();
    try {
      await db.query('begin');
      let row;
      if(body.id.startsWith('stale:')) {
        row=(await db.query(`select id as run_id,submission_id,'FUNDING_UNKNOWN' as kind from engine_runs where id=$1 and factor_id=$2 and state='FUNDING' and updated_at<now()-interval '5 minutes' for update`,[body.id.slice(6),session.factorId])).rows[0];
      } else row=(await db.query("select * from recovery_items where id=$1 and factor_id=$2 and status='OPEN' for update",[body.id,session.factorId])).rows[0];
      if(!row) {await db.query('rollback');return NextResponse.json({error:'Open item not found.'},{status:404});}
      if(row.kind==='FUNDING_UNKNOWN') {
        if(body.outcome==='repaired') {await db.query('rollback');return NextResponse.json({error:'Confirm whether the funding batch was funded or not funded.'},{status:400});}
        const changed=await db.query(`update engine_runs set state=$3,detail=$4,updated_at=now(),funded_at=case when $3='FUNDED' then now() else funded_at end,
          auto_funded=case when $3='FUNDED' then exists(select 1 from funding_reservations where run_id=$1) else auto_funded end
          where id=$1 and factor_id=$2 and state='FUNDING' returning id`,[row.run_id,session.factorId,body.outcome==='funded'?'FUNDED':'APPROVED',body.evidence]);
        if(!changed.rowCount) throw new Error('Funding state changed. Refresh and inspect it again.');
        await db.query('update funding_reservations set status=$2 where run_id=$1',[row.run_id,body.outcome==='funded'?'CONFIRMED':'RELEASED']);
      } else if(body.outcome!=='repaired') {await db.query('rollback');return NextResponse.json({error:'This item requires a repair confirmation.'},{status:400});}
      await db.query("update recovery_items set status='RESOLVED',resolution=$3,resolved_by=$4,resolved_at=now() where factor_id=$1 and (id=$2 or (run_id=$5 and status='OPEN'))",[session.factorId,body.id,body.evidence,session.userId,row.run_id??null]);
      await db.query(`insert into audit_events(id,factor_id,submission_id,actor_user_id,event_type,event_data) values($1,$2,$3,$4,'RECOVERY_RECONCILED',$5::jsonb)`,[`audit_${randomUUID()}`,session.factorId,row.submission_id,session.userId,JSON.stringify({item:body.id,outcome:body.outcome,evidence:body.evidence})]);
      await db.query('commit'); return NextResponse.json({ok:true});
    } catch(err) {await db.query('rollback');throw err;} finally {db.release();}
  } catch(err) {return apiErrorResponse(err,'recovery');}
}
