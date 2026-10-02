import 'server-only';
import { randomUUID } from 'crypto';
import { query } from './db';
import { ensureSendStageSchema } from './schema';

export async function openRecovery(input: { factorId: string; submissionId?: string | null; runId?: string | null; kind: string; detail: string }): Promise<void> {
  await query(`insert into recovery_items(id,factor_id,submission_id,run_id,kind,detail)
    values($1,$2,$3,$4,$5,$6)`, [`rec_${randomUUID()}`,input.factorId,input.submissionId??null,input.runId??null,input.kind,input.detail]);
}

/** A crash can happen before the normal error handler. Surface stale in-flight records as well. */
export async function recoveryQueue(factorId: string) {
  await ensureSendStageSchema();
  return query(`select r.id,r.kind,r.detail,r.created_at,r.submission_id,r.run_id,
      s.invoice_number_submitted as invoice_number,s.factorcloud_invoice_id
    from recovery_items r left join submissions s on s.id=r.submission_id
    where r.factor_id=$1 and r.status='OPEN'
      -- a client's fix upload in progress only needs a person once it has been stuck a while
      and not (r.kind='FIX_SENDING' and r.created_at>now()-interval '5 minutes')
    union all
    -- one item per FactorCloud batch: reconciling it settles every invoice in the batch
    select 'stale:'||e.id,'FUNDING_UNKNOWN','Funding has not completed. Check the batch in FactorCloud before resolving.',e.updated_at,e.submission_id,e.id,e.invoice_number,e.factorcloud_invoice_id
    from engine_runs e where e.factor_id=$1 and e.state='FUNDING' and e.updated_at<now()-interval '5 minutes'
      and not exists(select 1 from recovery_items r join engine_runs o on o.id=r.run_id where r.status='OPEN' and r.kind='FUNDING_UNKNOWN'
        and (o.id=e.id or (e.invoice_group_id is not null and o.invoice_group_id=e.invoice_group_id)))
      and not exists(select 1 from engine_runs o where o.factor_id=e.factor_id and o.state='FUNDING' and e.invoice_group_id is not null
        and o.invoice_group_id=e.invoice_group_id and o.id<e.id)
    union all
    -- sending a submission stopped part-way (a crash or timeout skipped the normal error handling)
    select 'send:'||s.id,case when s.factorcloud_invoice_id is null then 'CREATE_UNKNOWN' else 'DOCUMENT_ATTACH' end,
      case when s.factorcloud_invoice_id is null then 'Sending stopped before the result was known. Check FactorCloud for this invoice before anyone resubmits it.'
        else 'Sending stopped after the invoice was created. Check that its documents are attached in FactorCloud.' end,
      s.updated_at,s.id,null,s.invoice_number_submitted,s.factorcloud_invoice_id
    from submissions s where s.factor_id=$1 and s.send_stage in ('SENDING','CREATED') and s.updated_at<now()-interval '10 minutes'
      and s.idempotency_released_at is null
      and not exists(select 1 from recovery_items r where r.submission_id=s.id and r.status='OPEN')
    union all
    select 'approval:'||e.id,'APPROVAL_UNKNOWN','Approval was interrupted. Verify the invoice and batch before retrying.',e.approval_started_at,e.submission_id,e.id,e.invoice_number,e.factorcloud_invoice_id
    from engine_runs e where e.factor_id=$1 and e.approval_status in ('CHECKING','SENDING','UNKNOWN') and e.approval_started_at<now()-interval '5 minutes'
      and not exists(select 1 from recovery_items r where r.run_id=e.id and r.kind='APPROVAL_UNKNOWN' and r.status='OPEN')
    order by created_at asc`, [factorId]);
}
