import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';
import { demoRequest } from '@/lib/demo-request';
import { pool } from '@/lib/db';
import { recoveryQueue } from '@/lib/recovery';
import { apiErrorResponse } from '@/lib/api-errors';
import { getInvoice } from '@/lib/factorcloud';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { normalizeIdentifier } from '@/lib/normalize';
import { RELEASED_KEY_MARKER } from '@/lib/submission-store';

export async function GET() {
  try {
    const session=await requireFactorSession();
    if (await demoRequest()) return NextResponse.json({items:[],editable:false});
    if (!databaseAuthEnabled()) return NextResponse.json({items:[],editable:false,note:'Recovery requires database sign-in.'});
    return NextResponse.json({items:await recoveryQueue(session.factorId),editable:session.role==='FACTOR_ADMIN'});
  } catch(err) {return apiErrorResponse(err,'recovery');}
}

export async function POST(req:Request) {
  try {
    const session=await requireFactorSession();
    if (await demoRequest() || !databaseAuthEnabled() || session.role!=='FACTOR_ADMIN') return NextResponse.json({error:'A database factor admin must reconcile this item.'},{status:403});
    const body=await req.json();
    if(typeof body.id!=='string' || typeof body.evidence!=='string' || body.evidence.trim().length<15 || body.evidence.length>2000 || !['repaired','funded','not-funded','created','not-created','approved','not-approved'].includes(body.outcome)) return NextResponse.json({error:'Choose an outcome and record what you verified in FactorCloud (15–2000 characters).'},{status:400});
    const linkedInvoice = body.outcome==='created' && typeof body.invoiceId==='string'
      ? collectRiskInvoiceRecords(await getInvoice(body.invoiceId)).find(i=>i.id===body.invoiceId) : null;
    const db=await pool().connect();
    try {
      await db.query('begin');
      let row;
      let batchRuns:string[]=[];
      if(body.id.startsWith('approval:')) {
        row=(await db.query(`select id as run_id,submission_id,'APPROVAL_UNKNOWN' as kind from engine_runs where id=$1 and factor_id=$2 and approval_status in ('CHECKING','SENDING','UNKNOWN') and approval_started_at<now()-interval '5 minutes' for update`,[body.id.slice(9),session.factorId])).rows[0];
      } else if(body.id.startsWith('stale:')) {
        row=(await db.query(`select id as run_id,submission_id,'FUNDING_UNKNOWN' as kind from engine_runs where id=$1 and factor_id=$2 and state='FUNDING' and updated_at<now()-interval '5 minutes' for update`,[body.id.slice(6),session.factorId])).rows[0];
      } else if(body.id.startsWith('send:')) {
        row=(await db.query(`select id as submission_id,null as run_id,case when factorcloud_invoice_id is null then 'CREATE_UNKNOWN' else 'DOCUMENT_ATTACH' end as kind from submissions
          where id=$1 and factor_id=$2 and send_stage in ('SENDING','CREATED') and idempotency_released_at is null and updated_at<now()-interval '10 minutes' for update`,[body.id.slice(5),session.factorId])).rows[0];
      } else row=(await db.query("select * from recovery_items where id=$1 and factor_id=$2 and status='OPEN' for update",[body.id,session.factorId])).rows[0];
      if(!row) {await db.query('rollback');return NextResponse.json({error:'Open item not found.'},{status:404});}
      if(row.kind==='CREATE_UNKNOWN') {
        const {rows:[submission]}=await db.query(`select s.*,c.factorcloud_client_id from submissions s join portal_clients c on c.id=s.client_id
          where s.id=$1 and s.factor_id=$2 for update of s`,[row.submission_id,session.factorId]);
        if(!submission) throw new Error('Submission not found.');
        if(body.outcome==='created') {
          if(!linkedInvoice || linkedInvoice.companyClientId!==submission.factorcloud_client_id ||
            normalizeIdentifier(linkedInvoice.invoiceNumber??'')!==normalizeIdentifier(submission.invoice_number_submitted) ||
            (submission.factorcloud_invoice_id && submission.factorcloud_invoice_id!==linkedInvoice.id)) {
            await db.query('rollback'); return NextResponse.json({error:'The invoice must match this submission and its client.'},{status:400});
          }
          await db.query("update submissions set factorcloud_invoice_id=$2,workflow_status='REVIEW_REQUIRED',updated_at=now() where id=$1",[submission.id,linkedInvoice.id]);
          await db.query(`insert into recovery_items(id,factor_id,submission_id,kind,detail) values($1,$2,$3,'DOCUMENT_ATTACH','Invoice linked after uncertain creation. Verify and repair documents in FactorCloud before approval.')`,[`rec_${randomUUID()}`,session.factorId,submission.id]);
        } else if(body.outcome==='not-created' && !submission.factorcloud_invoice_id) {
          await db.query(`update submissions set idempotency_key=case when idempotency_released_at is null then idempotency_key||$2||id else idempotency_key end,
            idempotency_released_at=coalesce(idempotency_released_at,now()),workflow_status='ERROR',updated_at=now() where id=$1`,[submission.id,RELEASED_KEY_MARKER]);
        } else {await db.query('rollback');return NextResponse.json({error:'Choose created with invoiceId, or not-created after confirming no invoice exists. A known invoice cannot be released.'},{status:400});}
      } else if(row.kind==='APPROVAL_UNKNOWN') {
        if(!['approved','not-approved'].includes(body.outcome) || (body.outcome==='approved' && (typeof body.invoiceGroupId!=='string'||!body.invoiceGroupId.trim()||typeof body.paymentType!=='string'))) {
          await db.query('rollback');return NextResponse.json({error:'Confirm approved with invoiceGroupId and paymentType, or not-approved after checking FactorCloud.'},{status:400});
        }
        const changed=await db.query(`update engine_runs set approval_status=$3,approval_token=null,state=$4,invoice_group_id=$5,payment_type=$6,detail=$7,updated_at=now()
          where id=$1 and factor_id=$2 and approval_status in ('CHECKING','SENDING','UNKNOWN') and state in ('FAILED','SUGGESTED','APPROVED') returning id`,
          [row.run_id,session.factorId,body.outcome==='approved'?'COMPLETE':'IDLE',body.outcome==='approved'?'APPROVED':'SUGGESTED',body.outcome==='approved'?body.invoiceGroupId:null,body.outcome==='approved'?body.paymentType:null,body.evidence]);
        if(!changed.rowCount) throw new Error('Approval state changed. Refresh and inspect it again.');
      } else if(row.kind==='FUNDING_UNKNOWN') {
        if(!['funded','not-funded'].includes(body.outcome)) {await db.query('rollback');return NextResponse.json({error:'Confirm whether the funding batch was funded or not funded.'},{status:400});}
        // FactorCloud funds whole batches, so the answer holds for every portal invoice in this one.
        const changed=await db.query(`update engine_runs e set state=$3,detail=$4,updated_at=now(),funded_at=case when $3='FUNDED' then now() else e.funded_at end,
          auto_funded=case when $3='FUNDED' then exists(select 1 from funding_reservations f where f.run_id=e.id) else e.auto_funded end
          from engine_runs owner
          where owner.id=$1 and owner.factor_id=$2 and e.factor_id=$2 and e.state='FUNDING'
            and (e.id=owner.id or (owner.invoice_group_id is not null and e.invoice_group_id=owner.invoice_group_id))
          returning e.id`,[row.run_id,session.factorId,body.outcome==='funded'?'FUNDED':'APPROVED',body.evidence]);
        if(!changed.rowCount) throw new Error('Funding state changed. Refresh and inspect it again.');
        batchRuns=changed.rows.map((r:{id:string})=>r.id);
        await db.query('update funding_reservations set status=$2 where run_id = any($1::text[])',[batchRuns,body.outcome==='funded'?'CONFIRMED':'RELEASED']);
      } else if(body.outcome!=='repaired') {await db.query('rollback');return NextResponse.json({error:'This item requires a repair confirmation.'},{status:400});}
      else if(row.submission_id && ['DOCUMENT_ATTACH','DOCUMENT_UPLOAD'].includes(row.kind)) {
        // The documents were checked and repaired in FactorCloud: sending this submission is finished.
        await db.query("update submissions set send_stage='COMPLETE',updated_at=now() where id=$1 and factor_id=$2 and send_stage is not null",[row.submission_id,session.factorId]);
      }
      await db.query("update recovery_items set status='RESOLVED',resolution=$3,resolved_by=$4,resolved_at=now() where factor_id=$1 and kind=$6 and status='OPEN' and (id=$2 or run_id = any($5::text[]) or (submission_id=$7 and $6='CREATE_UNKNOWN'))",[session.factorId,body.id,body.evidence,session.userId,batchRuns.length?batchRuns:[row.run_id??''],row.kind,row.submission_id??null]);
      await db.query(`insert into audit_events(id,factor_id,submission_id,actor_user_id,event_type,event_data) values($1,$2,$3,$4,'RECOVERY_RECONCILED',$5::jsonb)`,[`audit_${randomUUID()}`,session.factorId,row.submission_id,session.userId,JSON.stringify({item:body.id,outcome:body.outcome,evidence:body.evidence,runs:batchRuns.length?batchRuns:undefined,invoiceId:linkedInvoice?.id,invoiceGroupId:body.invoiceGroupId,paymentType:body.paymentType})]);
      await db.query('commit'); return NextResponse.json({ok:true});
    } catch(err) {await db.query('rollback');throw err;} finally {db.release();}
  } catch(err) {return apiErrorResponse(err,'recovery');}
}
