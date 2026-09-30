import 'server-only';
import { pool, query } from './db';
import type { RuleSettings } from './rules/settings';
import { normalizeSettings, settingsForClient } from './rules/settings';

/**
 * Claims a FactorCloud funding batch before money moves: the run and every other portal invoice in
 * the same batch (`siblings`, found by asking FactorCloud what the batch contains) switch from
 * APPROVED to FUNDING together, so no second click or process can fund them again.
 * Automatic funding also applies the caps to the whole batch, since funding it pays every invoice
 * in it, and serializes cap reservations across ALL invoices of a factor.
 */
export async function claimFunding(runId: string, auto: boolean, settings: RuleSettings, siblings: string[] = []): Promise<boolean> {
  const db = await pool().connect();
  try {
    await db.query('begin');
    const ids = [...new Set([runId, ...siblings])].sort();
    const { rows } = await db.query('select * from engine_runs where id = any($1::text[]) order by id for update', [ids]);
    const run = rows.find((r) => r.id === runId);
    if (!run || rows.length !== ids.length || rows.some((r) => r.factor_id !== run.factor_id || r.state !== 'APPROVED' || !['IDLE','COMPLETE'].includes(r.approval_status) || !(Number(r.amount) > 0))) {
      await db.query('rollback'); return false;
    }
    const { rows: [active] } = await db.query("select count(*)::int as n from funding_reservations where run_id = any($1::text[]) and status<>'RELEASED'", [ids]);
    if (Number(active?.n ?? 0) > 0) { await db.query('rollback'); return false; }
    const amount = rows.reduce((t, r) => t + Number(r.amount), 0);
    const timezone = process.env.FACTOR_TIMEZONE || 'America/Chicago';
    if (auto) {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`funding:${run.factor_id}`]);
      // Share the settings writer's lock so a queued claim observes the latest committed policy.
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`rules:${run.factor_id}`]);

      // FactorCloud funds invoice groups, not individual invoices, and approving an invoice adds it
      // to the client's open group. Only fund a group automatically when every portal invoice in it
      // passed every rule: never sweep in one that is waiting for a person or was funded by hand.
      if (rows.some((r) => r.outcome !== 'FUND' || r.mode !== 'fund')) {
        await db.query("update engine_runs set detail='Automatic funding held: FactorCloud grouped this invoice with another invoice that requires a person.' where id=$1", [runId]);
        await db.query('commit'); return false;
      }
      if (run.invoice_group_id) {
        const { rows: [sharedBatch] } = await db.query(`
          select count(*)::int as blockers
          from engine_runs
          where factor_id=$1 and invoice_group_id=$2 and not (id = any($3::text[]))
            and not (outcome='FUND' and mode='fund' and state='FUNDED' and auto_funded)
        `, [run.factor_id, run.invoice_group_id, ids]);
        if (Number(sharedBatch?.blockers ?? 0) > 0) {
          await db.query("update engine_runs set detail='Automatic funding held: FactorCloud grouped this invoice with another invoice that requires a person.' where id=$1", [runId]);
          await db.query('commit'); return false;
        }
      }

      const { rows: [policy] } = await db.query('select settings from rule_settings where factor_id=$1', [run.factor_id]);
      if (policy) settings = settingsForClient(normalizeSettings(policy.settings), run.factorcloud_client_id);
      const { rows: [clock] } = await db.query(`select
        extract(isodow from clock_timestamp() at time zone $1) between 1 and 5
        and extract(hour from clock_timestamp() at time zone $1) >= 8
        and extract(hour from clock_timestamp() at time zone $1) < 18 as open`, [timezone]);
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
      if (settings.mode !== 'fund' || (settings.caps.businessHoursOnly && !clock.open) || rows.some((r) => Number(r.amount) > settings.caps.perInvoice) ||
          Number(totals.client)+amount > settings.caps.perClientPerDay ||
          Number(totals.factor)+amount > settings.caps.perFactorPerDay ||
          (settings.caps.autoFundClients !== 'all' && !settings.caps.autoFundClients.includes(run.factorcloud_client_id))) {
        await db.query(`update engine_runs set detail=$2 where id=$1`, [runId, rows.length > 1
          ? `Automatic funding held: FactorCloud batches this invoice with ${rows.length - 1} other${rows.length === 2 ? '' : 's'}, and together they are over the mode, allow-list or daily cap.`
          : 'Automatic funding held: current mode, allow-list or reserved daily cap prevents funding.']);
        await db.query('commit'); return false;
      }
      for (const r of rows) {
        const reserved = await db.query(`insert into funding_reservations(run_id,factor_id,client_id,business_day,amount,status)
          values($1,$2,$3,(now() at time zone $4)::date,$5,'RESERVED')
          on conflict(run_id) do update set status='RESERVED',business_day=excluded.business_day,amount=excluded.amount
          where funding_reservations.status='RELEASED'`, [r.id,r.factor_id,r.factorcloud_client_id,timezone,Number(r.amount)]);
        if (reserved.rowCount !== 1) { await db.query('rollback'); return false; }
      }
    }
    await db.query("update engine_runs set state='FUNDING',updated_at=now() where id = any($1::text[])",[ids]);
    await db.query('commit'); return true;
  } catch(err) { await db.query('rollback'); throw err; } finally { db.release(); }
}

export async function fundingReservationResult(runId: string, status: 'CONFIRMED' | 'UNKNOWN'): Promise<void> {
  await query('update funding_reservations set status=$2 where run_id=$1',[runId,status]);
}
