import {NextResponse} from 'next/server';
import {requireFactorSession} from '@/lib/portal-auth';
import {databaseAuthEnabled} from '@/lib/session';
import {demoRequest} from '@/lib/demo-request';
import {apiErrorResponse} from '@/lib/api-errors';
import {query,pool} from '@/lib/db';
import {randomUUID} from 'crypto';
import {processNotifications} from '@/lib/notifications';
export async function GET(){try{const s=await requireFactorSession();if(await demoRequest()||!databaseAuthEnabled())return NextResponse.json({items:[]});return NextResponse.json({items:await query('select id,recipient,subject,status,last_error,created_at,sent_at from notification_outbox where factor_id=$1 order by created_at desc limit 100',[s.factorId])});}catch(e){return apiErrorResponse(e,'notifications');}}
// Explicit operator action. A scheduler can instead invoke scripts/notification-worker.mjs.
export async function POST(){try{const s=await requireFactorSession();if(s.role!=='FACTOR_ADMIN'||await demoRequest()||!databaseAuthEnabled())return NextResponse.json({error:'Database admin required.'},{status:403});
  // Delivery processes this deployment's outbox. Each deployment is configured for one factor.
  return NextResponse.json(await processNotifications(s.factorId));}catch(e){return apiErrorResponse(e,'notifications');}}

/** Retry only after the operator confirms that the provider did not accept the previous send. */
export async function PATCH(req:Request){try{
  const s=await requireFactorSession();
  if(s.role!=='FACTOR_ADMIN'||await demoRequest()||!databaseAuthEnabled())return NextResponse.json({error:'Database admin required.'},{status:403});
  const b=await req.json();
  if(typeof b.id!=='string'||!['sent','not-sent'].includes(b.outcome)||typeof b.evidence!=='string'||b.evidence.trim().length<15||b.evidence.length>2000)return NextResponse.json({error:'Confirm sent or not-sent and provide provider evidence (15–2000 characters).'},{status:400});
  const db=await pool().connect();try{
    await db.query('begin');
    const changed=await db.query(`update notification_outbox set status=$3,available_at=now(),attempts=case when $3='PENDING' then 0 else attempts end,
      sent_at=case when $3='SENT' then now() else sent_at end,last_error=null where id=$1 and factor_id=$2 and status='FAILED' returning id`,[b.id,s.factorId,b.outcome==='sent'?'SENT':'PENDING']);
    if(!changed.rowCount){await db.query('rollback');return NextResponse.json({error:'Failed delivery not found.'},{status:404});}
    await db.query(`insert into audit_events(id,factor_id,actor_user_id,event_type,event_data) values($1,$2,$3,'NOTIFICATION_RECONCILED',$4::jsonb)`,[`audit_${randomUUID()}`,s.factorId,s.userId,JSON.stringify({id:b.id,outcome:b.outcome,evidence:b.evidence})]);
    await db.query('commit');return NextResponse.json({ok:true});
  }catch(e){await db.query('rollback');throw e;}finally{db.release();}
}catch(e){return apiErrorResponse(e,'notifications');}}
