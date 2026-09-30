import 'server-only';
import { pool, query } from './db';
import type { RuleSettings } from './rules/settings';

/** Serializes cap reservations across ALL invoices of a factor, not just one run. */
export async function claimFunding(runId: string, auto: boolean, settings: RuleSettings): Promise<boolean> {
  const db = await pool().connect();
  try {
    await db.query('begin');
    const { rows: [run] } = await db.query('select * from engine_runs where id=$1 for update', [runId]);
    if (!run || run.state !== 'APPROVED') { await db.query('rollback'); return false; }
    if (auto) {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`funding:${run.factor_id}`]);
      const timezone = process.env.FACTOR_TIMEZONE || 'America/Chicago';
      const { rows: [totals] } = await db.query(`
        select coalesce(sum(amount),0) as factor,
          coalesce(sum(amount) filter (where client_id=$2),0) as client from (
          select amount,client_id from funding_reservations where factor_id=$1 and
            (business_day=(now() at time zone $3)::date or status in ('RESERVED','UNKNOWN')) and status<>'RELEASED'
          union all
          select amount,factorcloud_client_id from engine_runs r where factor_id=$1 and auto_funded
            and (funded_at at time zone $3)::date=(now() at time zone $3)::date
            and not exists(select 1 from funding_reservations b where b.run_id=r.id)
        ) budget`, [run.factor_id, run.factorcloud_client_id, timezone]);
      const amount = Number(run.amount);
      if (settings.mode !== 'fund' || amount > settings.caps.perInvoice ||
          Number(totals.client)+amount > settings.caps.perClientPerDay ||
          Number(totals.factor)+amount > settings.caps.perFactorPerDay ||
          (settings.caps.autoFundClients !== 'all' && !settings.caps.autoFundClients.includes(run.factorcloud_client_id))) {
        await db.query("update engine_runs set detail='Automatic funding held: current mode, allow-list or reserved daily cap prevents funding.' where id=$1", [runId]);
        await db.query('commit'); return false;
      }
      await db.query(`insert into funding_reservations(run_id,factor_id,client_id,business_day,amount,status)
        values($1,$2,$3,(now() at time zone $4)::date,$5,'RESERVED')
        on conflict(run_id) do update set status='RESERVED',business_day=excluded.business_day,amount=excluded.amount
        where funding_reservations.status='RELEASED'`, [runId,run.factor_id,run.factorcloud_client_id,timezone,amount]);
    }
    await db.query("update engine_runs set state='FUNDING',updated_at=now() where id=$1",[runId]);
    await db.query('commit'); return true;
  } catch(err) { await db.query('rollback'); throw err; } finally { db.release(); }
}

export async function fundingReservationResult(runId: string, status: 'CONFIRMED' | 'UNKNOWN'): Promise<void> {
  await query('update funding_reservations set status=$2 where run_id=$1',[runId,status]);
}
