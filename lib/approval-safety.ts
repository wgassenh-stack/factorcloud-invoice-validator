import 'server-only';
import { query } from './db';
import { openRecovery } from './recovery';
import { randomUUID } from 'crypto';

/** Claim before fetching facts. An interrupted claim stays blocked until reconciliation. */
export async function withApprovalClaim<T>(runId: string, work: (token:string) => Promise<T>): Promise<T | { ok: false; detail: string }> {
  const token=randomUUID();
  const [run] = await query(`update engine_runs set approval_status='CHECKING',approval_started_at=now(),approval_token=$2
    where id=$1 and state in ('SUGGESTED','FAILED') and approval_status='IDLE'
    returning factor_id,submission_id`, [runId,token]);
  if (!run) return { ok: false, detail: 'Approval is already in progress or requires reconciliation.' };
  try {
    return await work(token);
  } catch (err) {
    const [uncertain] = await query(`update engine_runs set approval_status='UNKNOWN',detail='Approval interrupted. Check FactorCloud before retrying.'
      where id=$1 and approval_token=$2 and approval_status='SENDING' returning id`, [runId,token]);
    if (uncertain) await openRecovery({factorId:run.factor_id,submissionId:run.submission_id,runId,kind:'APPROVAL_UNKNOWN',detail:'Approval interrupted. Verify the invoice and funding batch before retrying.'});
    throw err;
  } finally {
    await query("update engine_runs set approval_status='IDLE',approval_token=null where id=$1 and approval_token=$2 and approval_status='CHECKING'", [runId,token]);
  }
}
