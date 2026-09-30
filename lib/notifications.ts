import 'server-only';
import { randomUUID } from 'crypto';
import { query } from './db';

/** Idempotent enqueue, including a single reminder after 24 hours. No email is sent in a request. */
export async function enqueueFixNotifications(factorId:string): Promise<number> {
  const rows=await query(`insert into notification_outbox(id,factor_id,task_id,recipient,subject,message,dedupe_key)
    select 'mail_'||md5(t.id||u.id||stage.name),t.factor_id,t.id,u.email,
      case when stage.name='reminder' then 'Reminder: paperwork needs a fix' else 'Your paperwork needs a fix' end,
      'Please sign in to your FactorCloud portal to see a paperwork request.',
      t.id||':'||u.id||':'||stage.name
    from client_tasks t join submissions s on s.id=t.submission_id
    join user_client_access a on a.client_id=t.client_id
    join portal_users u on u.id=a.user_id and u.factor_id=t.factor_id
    cross join (values ('initial'),('reminder')) stage(name)
    where t.factor_id=$1 and t.status='OPEN' and u.is_active and
      (u.role='CLIENT_USER' or (u.role='DRIVER' and s.submitted_by_user_id=u.id)) and
      (stage.name='initial' or exists(select 1 from notification_outbox initial
        where initial.dedupe_key=t.id||':'||u.id||':initial' and initial.status='SENT' and initial.sent_at<now()-interval '24 hours'))
    on conflict(dedupe_key) do nothing returning id`,[factorId]);
  return rows.length;
}

export async function processNotifications(factorId:string):Promise<{sent:number;failed:number;disabled?:boolean}> {
  if(process.env.NOTIFICATIONS_ENABLED!=='true'||!process.env.RESEND_API_KEY||!process.env.NOTIFICATION_FROM)return {sent:0,failed:0,disabled:true};
  await enqueueFixNotifications(factorId);
  // A worker interruption is uncertain. Keep it visible for an operator; do not blindly redeliver.
  await query(`update notification_outbox set status='FAILED',last_error='Delivery interrupted; check the provider before retrying.' where factor_id=$1 and status='SENDING' and available_at<now()-interval '10 minutes'`,[factorId]);
  let sent=0,failed=0;
  // Claim one at a time: a slow provider cannot strand a large claimed batch past the worker deadline.
  for(let index=0;index<3;index++){
    const [row]=await query<{id:string;recipient:string;subject:string;message:string;attempts:number}>(`update notification_outbox set status='SENDING',attempts=attempts+1,available_at=now()
      where id in(select id from notification_outbox where factor_id=$1 and status='PENDING' and available_at<=now() order by created_at for update skip locked limit 1) returning id,recipient,subject,message,attempts`,[factorId]);
    if(!row) break;
    const [eligible]=await query(`select n.id from notification_outbox n where n.id=$1 and (
      (n.task_id is not null and exists(select 1 from client_tasks t join submissions s on s.id=t.submission_id
        join portal_clients c on c.id=t.client_id and c.is_active
        join user_client_access a on a.client_id=t.client_id join portal_users u on u.id=a.user_id
        where t.id=n.task_id and t.factor_id=n.factor_id and t.status='OPEN' and u.factor_id=n.factor_id and u.is_active
        and u.email=n.recipient and (u.role='CLIENT_USER' or (u.role='DRIVER' and s.submitted_by_user_id=u.id))
        and n.dedupe_key in (t.id||':'||u.id||':initial',t.id||':'||u.id||':reminder')))
      or (n.task_id is null and exists(select 1 from driver_invites i join portal_clients c on c.id=i.client_id and c.is_active
        where n.dedupe_key='invite:'||i.token_hash and i.factor_id=n.factor_id and i.email=n.recipient
        and i.accepted_at is null and i.revoked_at is null and i.expires_at>now())))`,[row.id]);
    if(!eligible){await query("update notification_outbox set status='CANCELED',last_error='Recipient access or invitation is no longer valid.' where id=$1",[row.id]);continue;}
    try{
      const response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':row.id},body:JSON.stringify({from:process.env.NOTIFICATION_FROM,to:[row.recipient],subject:row.subject,text:row.message})});
      if(response.status===429 && row.attempts<5){
        await query("update notification_outbox set status='PENDING',available_at=now()+interval '5 minutes',last_error='Provider rate limit; retry scheduled.' where id=$1",[row.id]);continue;
      }
      if(!response.ok)throw Error(`Provider refused delivery (${response.status}).`);
      await query("update notification_outbox set status='SENT',sent_at=now(),last_error=null where id=$1",[row.id]);sent++;
    }catch(err){await query("update notification_outbox set status='FAILED',last_error=$2 where id=$1",[row.id,err instanceof Error?err.message:'Delivery failed']);failed++;}
  }
  return {sent,failed};
}

export async function queueInvitation(factorId:string,email:string,url:string,key:string,db?:Pick<import('pg').PoolClient,'query'>){
  const sql=`insert into notification_outbox(id,factor_id,recipient,subject,message,dedupe_key) values($1,$2,$3,'Your FactorCloud driver invitation',$4,$5) on conflict(dedupe_key) do nothing`;
  const values=[`mail_${randomUUID()}`,factorId,email,`Create your driver account using this invitation (expires in 48 hours): ${url}`,key];
  if(db) await db.query(sql,values); else await query(sql,values);
}
