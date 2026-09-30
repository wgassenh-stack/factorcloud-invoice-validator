import 'server-only';
import { randomUUID } from 'crypto';
import { query } from './db';

export async function openRecovery(input: { factorId: string; submissionId?: string | null; runId?: string | null; kind: string; detail: string }): Promise<void> {
  await query(`insert into recovery_items(id,factor_id,submission_id,run_id,kind,detail)
    values($1,$2,$3,$4,$5,$6)`, [`rec_${randomUUID()}`,input.factorId,input.submissionId??null,input.runId??null,input.kind,input.detail]);
}

/** A crash can happen before the normal error handler. Surface stale in-flight records as well. */
export async function recoveryQueue(factorId: string) {
  return query(`select r.id,r.kind,r.detail,r.created_at,r.submission_id,r.run_id,
      s.invoice_number_submitted as invoice_number,s.factorcloud_invoice_id
    from recovery_items r left join submissions s on s.id=r.submission_id
    where r.factor_id=$1 and r.status='OPEN'
    union all
    select 'stale:'||e.id,'FUNDING_UNKNOWN','Funding has not completed. Check the batch in FactorCloud before resolving.',e.updated_at,e.submission_id,e.id,e.invoice_number,e.factorcloud_invoice_id
    from engine_runs e where e.factor_id=$1 and e.state='FUNDING' and e.updated_at<now()-interval '5 minutes'
      and not exists(select 1 from recovery_items r where r.run_id=e.id and r.status='OPEN')
    order by created_at asc`, [factorId]);
}
