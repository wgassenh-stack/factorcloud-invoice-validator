import 'server-only';

import { randomUUID } from 'crypto';
import { claimFunding, fundingReservationResult } from './funding-safety';
import { openRecovery } from './recovery';
import { withApprovalClaim } from './approval-safety';
import { isDefinitiveCreateFailure } from './errors';
import { query, pool } from './db';
import type { DebtorCredit } from './credit';
import { loadDebtorCredit } from './debtor-credit';
import { getCompany, getInvoice, listInvoices, updateInvoiceNotes } from './factorcloud';
import { approveForFunding, FUNDABLE_PAYMENT_TYPES, fundInvoiceGroups, getCashReserveBalance, getInvoiceGroup, groupInvoiceIds, invoiceGroupOf, getClientCreditLimit, listFundingInstructions, pickFundingInstruction, verifyInvoices } from './funding-api';
import { portalUpdateNote } from './portal-notes';
import { collectRiskInvoiceRecords, type RiskInvoiceRecord } from './risk';
import { decide, type Decision, type RuleResult, type EngineFacts } from './rules/engine';
import { DEFAULT_SETTINGS, normalizeSettings, settingsForClient, type RuleSettings } from './rules/settings';
import { remoteState, type RemoteState } from './factorcloud-sync';
import { ensureEngineSchema } from './schema';

// Runs the factor's rules on a newly sent invoice and acts on the result in FactorCloud, as far as
// the factor's mode allows:
//   suggest  record what the engine would do; people do everything
//   approve  verify and approve for funding (FUND and HOLD alike); people click Fund
//   fund     also fund invoices that pass every rule and cap (FUND)
// Every step is recorded in engine_runs. Nothing here throws into the send step: the invoice is
// already created, and a failure leaves it for a person.

export type RunState = 'SUGGESTED' | 'REVIEW' | 'APPROVED' | 'FUNDING' | 'FUNDED' | 'FAILED' | 'CLOSED';

export interface EngineRun {
  id: string;
  factorCloudInvoiceId: string;
  factorCloudClientId: string;
  clientName: string | null;
  /** From the facts recorded at the decision; null for runs recorded before that. */
  debtorName?: string | null;
  debtorId?: string | null;
  invoiceNumber: string | null;
  submissionId: string | null;
  amount: number;
  mode: string;
  outcome: Decision['outcome'];
  state: RunState;
  approvalStatus?: string;
  rules: RuleResult[];
  reasons: string[];
  detail: string | null;
  invoiceGroupId: string | null;
  paymentType: string | null;
  autoFunded: boolean;
  fundedAt: string | null;
  createdAt: string;
}

export async function loadSettings(factorId: string): Promise<RuleSettings> {
  await ensureEngineSchema();
  const [row] = await query<{ settings: unknown }>('select settings from rule_settings where factor_id = $1', [factorId]);
  return row ? normalizeSettings(row.settings) : normalizeSettings(DEFAULT_SETTINGS);
}

/** The settings for the signed-in factor (and one client, when given), or null when the engine can't run (no database sign-in). */
export async function engineSettingsFor(factorId: string | null | undefined, clientId?: string): Promise<RuleSettings | null> {
  if (!factorId) return null;
  try { return settingsForClient(await loadSettings(factorId), clientId); } catch (err) { console.error('[funding-engine] settings', err); return null; }
}

export async function saveSettings(factorId: string, userId: string | null, settings: unknown): Promise<RuleSettings> {
  await ensureEngineSchema();
  const clean = normalizeSettings(settings);
  const db=await pool().connect();
  try {
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', ['rules:'+factorId]);
    await db.query(`insert into rule_settings(factor_id,settings,updated_by_user_id,updated_at) values($1,$2::jsonb,$3,now())
      on conflict(factor_id) do update set settings=excluded.settings,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`,[factorId,JSON.stringify(clean),userId]);
    await db.query('insert into rule_versions(factor_id,settings,actor_id) values($1,$2::jsonb,$3)',[factorId,JSON.stringify(clean),userId]);
    await db.query('commit');
  } catch(err) {await db.query('rollback');throw err;} finally {db.release();}
  return clean;
}

async function fundedToday(factorId: string, clientId: string): Promise<{ client: number; factor: number }> {
  const [row] = await query<{ client: string | number | null; factor: string | number | null }>(`
    select coalesce(sum(amount) filter (where factorcloud_client_id = $2), 0) as client, coalesce(sum(amount), 0) as factor
    from engine_runs where factor_id = $1 and auto_funded
      and (funded_at at time zone $3)::date = (now() at time zone $3)::date
  `, [factorId, clientId, process.env.FACTOR_TIMEZONE || 'America/Chicago']);
  return { client: Number(row?.client ?? 0), factor: Number(row?.factor ?? 0) };
}

const settle = async <T>(fn: () => Promise<T>, label: string): Promise<T | null> => {
  try { return await fn(); } catch (err) { console.error(`[funding-engine] ${label}`, err); return null; }
};

const records = async (filter: { client?: string; debtor?: string }): Promise<RiskInvoiceRecord[] | null> => {
  const list = await listInvoices(filter);
  // An incomplete list could hide the very invoices a rule looks for, so it counts as unreadable.
  return list.complete ? collectRiskInvoiceRecords(list.raw) : null;
};

async function addNote(invoiceId: string, line: string): Promise<void> {
  await settle(async () => {
    const raw = await getInvoice(invoiceId) as { invoice?: { notes?: unknown } } | null;
    const current = typeof raw?.invoice?.notes === 'string' ? raw.invoice.notes : null;
    await updateInvoiceNotes(invoiceId, portalUpdateNote(current, line));
  }, 'note');
}

async function update(runId: string, fields: Partial<{ state: RunState; detail: string | null; invoice_group_id: string | null; payment_type: string | null; auto_funded: boolean; funded: boolean; funded_by_user_id: string | null }>): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'funded') { if (value) sets.push('funded_at = now()'); continue; }
    values.push(value);
    sets.push(`${key} = $${values.length}`);
  }
  values.push(runId);
  await query(`update engine_runs set ${sets.join(', ')} where id = $${values.length}`, values);
}

/** Verify and approve for funding. Returns the funding batch, or a reason it couldn't be done. */
async function approve(run: { id: string; invoiceId: string; clientId: string }, settings: RuleSettings, token:string): Promise<{ groupId: string | null; paymentType: string | null } | { error: string }> {
  const instructions = await settle(() => listFundingInstructions(run.clientId), 'funding instructions');
  if (!instructions) return { error: "The client's funding instructions could not be read." };
  const instruction = pickFundingInstruction(instructions);
  if (!instruction) return { error: 'The client has no funding instruction in FactorCloud, so it cannot be approved for funding.' };
  try {
    const claimed=await query("update engine_runs set approval_status='SENDING' where id=$1 and approval_status='CHECKING' and approval_token=$2 returning id", [run.id,token]);
    if(!claimed.length) return {error:'Approval claim changed. Refresh before continuing.'};
    if (settings.markVerified) await verifyInvoices([run.invoiceId], 'Checked by the FactorCloud client portal: the documents match the invoice.');
    const groups = await approveForFunding(run.clientId, instruction.id, [run.invoiceId]);
    // FactorCloud may add the invoice to an open batch and return several: ask which one it is in.
    // Funding re-checks this anyway, so an unreadable answer only leaves the batch blank for now.
    const actual = await invoiceGroupOf(run.invoiceId).catch((err) => { console.error('[funding-engine] batch lookup', err); return null; });
    const group = groups.find((g) => g.id === actual) ?? (groups.length === 1 ? groups[0] : null);
    const groupId = actual ?? group?.id ?? null;
    const paymentType = group?.paymentType ?? groups[0]?.paymentType ?? instruction.paymentMethod ?? null;
    const completed=await query("update engine_runs set approval_status='COMPLETE',state='APPROVED',invoice_group_id=$2,payment_type=$3,updated_at=now() where id=$1 and approval_token=$4 returning id", [run.id,groupId,paymentType,token]);
    if(!completed.length) throw new Error('Approval claim changed after the remote request. Check FactorCloud.');
    return { groupId, paymentType };
  } catch (err) {
    const uncertain = !isDefinitiveCreateFailure(err);
    await query('update engine_runs set approval_status=$2 where id=$1 and approval_token=$3', [run.id,uncertain?'UNKNOWN':'CHECKING',token]);
    if (uncertain) {
      const [owner] = await query('select factor_id,submission_id from engine_runs where id=$1',[run.id]);
      await openRecovery({factorId:owner.factor_id,submissionId:owner.submission_id,runId:run.id,kind:'APPROVAL_UNKNOWN',detail:'Approval outcome is unknown. Check the invoice and funding batch in FactorCloud.'});
      return { error: 'Approval outcome is unknown. Reconcile it before retrying.' };
    }
    return { error: `FactorCloud refused: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface BatchInvoice { runId: string | null; invoiceId: string; invoiceNumber: string | null; clientName: string | null; amount: number | null; state: RunState | null; outcome: Decision['outcome'] | null; mode: string | null }
export interface Batch { groupId: string; code: string | null; status: string | null; invoices: BatchInvoice[] }

/**
 * What funding this invoice would really fund: FactorCloud's batch for it and every invoice in that
 * batch, matched to the portal's decisions. Invoices the portal didn't decide on (approved by hand
 * in FactorCloud) have no run.
 */
export async function batchFor(factorId: string, invoiceId: string, knownGroupId: string | null): Promise<Batch> {
  const groupId = (await invoiceGroupOf(invoiceId)) ?? knownGroupId;
  if (!groupId) throw new Error('FactorCloud has no funding batch for this invoice yet.');
  const [group, ids] = await Promise.all([getInvoiceGroup(groupId), groupInvoiceIds(groupId)]);
  const members = ids.includes(invoiceId) ? ids : [invoiceId, ...ids];
  const rows = await query<{ id: string; factorcloud_invoice_id: string; invoice_number: string | null; client_name: string | null; amount: string | number; state: RunState; outcome: Decision['outcome']; mode: string }>(`
    select r.id, r.factorcloud_invoice_id, r.invoice_number, c.name as client_name, r.amount, r.state, r.outcome, r.mode
    from engine_runs r join portal_clients c on c.id = r.client_id
    where r.factor_id = $1 and r.factorcloud_invoice_id = any($2::text[])
    order by r.created_at desc`, [factorId, members]);
  const byInvoice = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!byInvoice.has(row.factorcloud_invoice_id)) byInvoice.set(row.factorcloud_invoice_id, row);
  const invoices = await Promise.all(members.map(async (id): Promise<BatchInvoice> => {
    const r = byInvoice.get(id);
    if (r) return { runId: r.id, invoiceId: id, invoiceNumber: r.invoice_number, clientName: r.client_name, amount: Number(r.amount), state: r.state, outcome: r.outcome, mode: r.mode };
    // Approved outside the portal: look it up so a person can see what the click would fund.
    const record = await settle(async () => collectRiskInvoiceRecords(await getInvoice(id)).find((x) => x.id === id) ?? null, 'batch invoice');
    return { runId: null, invoiceId: id, invoiceNumber: record?.invoiceNumber ?? null, clientName: record?.companyClientName ?? null, amount: record?.invoiceAmount ?? null, state: null, outcome: null, mode: null };
  }));
  return { groupId, code: group.code, status: group.status, invoices };
}

const label = (i: BatchInvoice) => i.invoiceNumber ?? 'an invoice approved outside the portal';

/** The batch holds exactly the invoices (and amounts) the person reviewed. */
export function sameBatch(now: { invoiceId: string; amount: number | null }[], reviewed: { invoiceId: string; amount: number | null }[]): boolean {
  if (now.length !== reviewed.length) return false;
  const seen = new Map(reviewed.map((i) => [i.invoiceId, i.amount]));
  return now.every((i) => {
    if (!seen.has(i.invoiceId)) return false;
    const before = seen.get(i.invoiceId);
    return before == null || i.amount == null || Math.abs(before - i.amount) < 0.005;
  });
}

/**
 * Funds the FactorCloud batch an approved invoice is in. FactorCloud pays the whole batch, so this
 * first asks what the batch holds. Automatic funding only goes ahead when every invoice in it passed
 * every rule; a person's click funds the whole batch, and the dialog showed them what that includes.
 * Every portal invoice in the batch is marked funded. Only one caller gets past the APPROVED →
 * FUNDING switch, so a double click can't fund twice.
 */
async function fund(runId: string, paymentType: string | null, auto: boolean, userId: string | null, opts: { onlyIfAlone?: boolean; expected?: ActOptions['expected'] } = {}): Promise<ActResult> {
  if (!paymentType || !(FUNDABLE_PAYMENT_TYPES as readonly string[]).includes(paymentType)) {
    const detail = `The client's payment method (${paymentType ?? 'none'}) can't be funded through the API. Fund it in FactorCloud.`;
    await update(runId, { detail });
    return { ok: false, detail };
  }
  const [owner] = await query<{factor_id:string;submission_id:string|null;factorcloud_client_id:string;factorcloud_invoice_id:string;invoice_group_id:string|null;invoice_number:string|null}>('select factor_id,submission_id,factorcloud_client_id,factorcloud_invoice_id,invoice_group_id,invoice_number from engine_runs where id=$1',[runId]);
  if (!owner) return { ok: false, detail: 'Not found.' };
  let batch: Batch;
  try { batch = await batchFor(owner.factor_id, owner.factorcloud_invoice_id, owner.invoice_group_id); }
  catch (err) {
    const detail = `Not funded: the FactorCloud funding batch for this invoice could not be checked (${err instanceof Error ? err.message : String(err)}). Try again in a moment.`;
    await update(runId, { detail });
    return { ok: false, detail };
  }
  const others = batch.invoices.filter((i) => i.runId !== runId);
  const name = batch.code ? `batch ${batch.code}` : 'its batch';
  if (batch.status !== 'NOT_FUNDED') {
    const detail = batch.status
      ? `Not funded: FactorCloud shows ${name} as ${batch.status.toLowerCase().replace(/_/g, ' ')}. Check it in FactorCloud.`
      : `Not funded: FactorCloud didn't say whether ${name} is still unfunded. Check it in FactorCloud.`;
    await update(runId, { detail, invoice_group_id: batch.groupId });
    return { ok: false, detail };
  }
  if (opts.expected && !sameBatch(batch.invoices, opts.expected)) {
    const detail = `Not funded: ${name} changed after you reviewed it. It now holds ${batch.invoices.map(label).join(', ')}. Review it again before funding.`;
    await update(runId, { detail, invoice_group_id: batch.groupId });
    return { ok: false, detail, batchChanged: true };
  }
  const blockers = auto ? others.filter((i) => !(i.runId && i.outcome === 'FUND' && i.mode === 'fund' && i.state === 'APPROVED')) : [];
  if (blockers.length) {
    const detail = `Held for a person: FactorCloud put this invoice in ${name} with ${blockers.map(label).join(', ')}, which ${blockers.length === 1 ? 'needs' : 'need'} a person. Funding the batch would fund ${blockers.length === 1 ? 'it' : 'them'} too.`;
    await update(runId, { detail, invoice_group_id: batch.groupId });
    return { ok: false, detail };
  }
  if (opts.onlyIfAlone && others.length) {
    const detail = `Approved. FactorCloud put it in ${name} with ${others.map(label).join(', ')}; funding pays the whole batch, so review it and click Fund.`;
    await update(runId, { detail, invoice_group_id: batch.groupId });
    return { ok: true, detail, approvedOnly: true };
  }
  const siblings = others.map((i) => i.runId).filter((id): id is string => Boolean(id));
  await query('update engine_runs set invoice_group_id=$2 where id = any($1::text[])', [[runId, ...siblings], batch.groupId]);
  if (!await claimFunding(runId, auto, settingsForClient(await loadSettings(owner.factor_id), owner.factorcloud_client_id), siblings)) {
    return { ok: false, detail: others.length ? 'Not funded: another invoice in the same FactorCloud batch is already being funded, reconciled, or held by a cap.' : 'Already funded, being reconciled, or held by the current funding cap.' };
  }
  const ids = [runId, ...siblings];
  try {
    // The same batch always gets the same transaction ID, so FactorCloud can refuse a repeat.
    await fundInvoiceGroups([batch.groupId], paymentType, `portal-fund-${batch.groupId}`);
    for (const id of ids) await fundingReservationResult(id, 'CONFIRMED');
    const how = auto ? 'Funded automatically: every rule passed.' : 'Funded.';
    await query(`update engine_runs set state='FUNDED', auto_funded=$2, funded_at=now(), funded_by_user_id=$3, updated_at=now(),
      detail=case when id=$4 then $5 else $6 end where id = any($1::text[])`,
      [ids, auto, auto ? null : userId, runId, how, `${how} Paid in the same FactorCloud batch as ${owner.invoice_number ?? 'another invoice'}.`]);
    const outside = others.filter((i) => !i.runId);
    return { ok: true, detail: others.length ? `Funded ${name}: ${[owner.invoice_number ?? 'this invoice', ...others.map(label)].join(', ')}.${outside.length ? ' Includes invoices approved outside the portal.' : ''}` : 'Funded.' };
  } catch (err) {
    const detail = `Funding failed: ${err instanceof Error ? err.message : String(err)}. Check the batch in FactorCloud before trying again.`;
    await query("update engine_runs set state='FUNDING', detail=$2, updated_at=now() where id = any($1::text[])", [ids, detail]);
    for (const id of ids) await fundingReservationResult(id, 'UNKNOWN');
    await openRecovery({factorId:owner.factor_id,submissionId:owner.submission_id,runId,kind:'FUNDING_UNKNOWN',detail});
    return { ok: false, detail };
  }
}

export interface EngineInput {
  factorId: string;
  portalClientId: string;
  submissionId: string | null;
  invoiceId: string;
  invoiceNumber: string;
  clientId: string;
  debtorId: string;
  amount: number;
  paperwork: 'PASS' | 'REVIEW';
  debtorCredit: DebtorCredit | null;
}

/** Reads fresh numbers from FactorCloud and runs the rules on them. */
async function decideNow(input: Omit<EngineInput, 'portalClientId' | 'submissionId' | 'invoiceNumber'>, settings: RuleSettings): Promise<Decision & { facts: EngineFacts }> {
  const [clientRecords, debtorRecords, clientCreditLimit, cashReserve, today] = await Promise.all([
    settle(() => records({ client: input.clientId }), 'client invoices'),
    settle(() => records({ debtor: input.debtorId }), 'debtor invoices'),
    getClientCreditLimit(input.clientId).catch((err) => { console.error('[funding-engine] client', err); return undefined; }),
    settle(() => getCashReserveBalance(input.clientId), 'cash reserve'),
    settle(() => fundedToday(input.factorId, input.clientId), 'funded today'),
  ]);
  const facts: EngineFacts = {
    invoice: { id: input.invoiceId, amount: input.amount, clientId: input.clientId, debtorId: input.debtorId },
    paperwork: input.paperwork,
    debtorCredit: input.debtorCredit,
    clientCreditLimit,
    clientRecords,
    debtorRecords,
    cashReserve,
    fundedToday: today,
    now: new Date(),
    timeZone: process.env.FACTOR_TIMEZONE || 'America/Chicago',
  };
  return { ...decide(facts, settings), facts };
}

/** Runs after an invoice is created. Returns the run, or null when the engine is off. Never throws. */
export async function runFundingEngine(input: EngineInput): Promise<EngineRun | null> {
  try {
    // The client's own rules when the factor has set some, otherwise the factor defaults.
    const settings = settingsForClient(await loadSettings(input.factorId), input.clientId);
    if (settings.mode === 'off') return null;
    const decision = await decideNow(input, settings);

    const runId = `run_${randomUUID()}`;
    // In auto-fund mode a held invoice is not approved in FactorCloud yet: approving adds it to the
    // client's open funding batch, and FactorCloud funds whole batches, so it would block (or be
    // swept into) the funding of the next clean invoice. It waits in the portal for one click that
    // approves and funds it.
    const heldHere = decision.outcome === 'HOLD' && settings.mode === 'fund';
    const initial: RunState = decision.outcome === 'REVIEW' ? 'REVIEW' : settings.mode === 'suggest' || heldHere ? 'SUGGESTED' : 'FAILED';
    await query(`
      insert into engine_runs (id, factor_id, client_id, submission_id, factorcloud_invoice_id, factorcloud_client_id, invoice_number, amount, mode, outcome, state, rules, reasons)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
    `, [runId, input.factorId, input.portalClientId, input.submissionId, input.invoiceId, input.clientId, input.invoiceNumber, input.amount, settings.mode, decision.outcome, initial, JSON.stringify(decision.rules), JSON.stringify(decision.reasons)]);

    await query('update engine_runs set settings_snapshot=$2::jsonb,facts_snapshot=$3::jsonb where id=$1',[runId,JSON.stringify(settings),JSON.stringify(decision.facts)]);

    if (heldHere) {
      await update(runId, { detail: 'Held for one click. Not approved in FactorCloud yet, so it stays out of other invoices\' funding batches.' });
      await addNote(input.invoiceId, `funding on hold for a person: ${decision.reasons.join('; ')}`);
    } else if (decision.outcome !== 'REVIEW' && settings.mode !== 'suggest') {
      await withApprovalClaim(runId, async (token) => {
      const approved = await approve({ id: runId, invoiceId: input.invoiceId, clientId: input.clientId }, settings,token);
      if ('error' in approved) {
        await query("update engine_runs set state='FAILED',detail=$2 where id=$1 and approval_token=$3 and state in ('SUGGESTED','FAILED')",[runId,approved.error,token]);
      } else {
        await query("update engine_runs set detail=$2 where id=$1 and state='APPROVED'", [runId,decision.outcome === 'HOLD' ? 'Approved for funding; waiting for a person to fund it.' : 'Approved for funding.']);
        if (decision.outcome === 'FUND' && settings.mode === 'fund') {
          const funded = await fund(runId, approved.paymentType, true, null);
          await addNote(input.invoiceId, funded.ok ? 'approved and funded automatically: every funding rule passed' : `approved for funding automatically; funding did not go through: ${funded.detail}`);
        } else {
          await addNote(input.invoiceId, decision.outcome === 'HOLD'
            ? `approved for funding automatically; funding on hold: ${decision.reasons.join('; ')}`
            : 'approved for funding automatically: every funding rule passed');
        }
      }
      });
    }
    return (await listRuns(input.factorId, { id: runId }))[0] ?? null;
  } catch (err) {
    console.error('[funding-engine] run failed', err);
    return null;
  }
}

type RunRow = {
  id: string; factorcloud_invoice_id: string; factorcloud_client_id: string; client_name: string | null; invoice_number: string | null; submission_id: string | null;
  amount: string | number; mode: string; outcome: Decision['outcome']; state: RunState; rules: RuleResult[]; reasons: string[]; detail: string | null;
  invoice_group_id: string | null; payment_type: string | null; auto_funded: boolean; funded_at: Date | string | null; created_at: Date | string; created_cursor?: string; approval_status?: string; debtor_name?: string | null; debtor_id?: string | null;
};

/**
 * The Funding Center's lanes. "Needs a click" holds approved invoices waiting to be funded and, in
 * auto-fund mode, held invoices waiting for one click that approves and funds them.
 */
export type Lane = 'decision' | 'suggestions' | 'exceptions' | 'funded' | 'review' | 'closed';
export const LANE_SQL: Record<Lane, string> = {
  decision: "(r.state = 'APPROVED' or (r.state = 'SUGGESTED' and r.mode = 'fund'))",
  suggestions: "(r.state = 'SUGGESTED' and r.mode <> 'fund')",
  exceptions: "r.state in ('FAILED', 'FUNDING')",
  funded: "r.state = 'FUNDED'",
  review: "r.state = 'REVIEW'",
  closed: "r.state = 'CLOSED'",
};
export function laneOf(run: Pick<EngineRun, 'state' | 'mode'>): Lane {
  if (run.state === 'SUGGESTED') return run.mode === 'fund' ? 'decision' : 'suggestions';
  return run.state === 'APPROVED' ? 'decision' : run.state === 'FUNDED' ? 'funded' : run.state === 'REVIEW' ? 'review' : run.state === 'CLOSED' ? 'closed' : 'exceptions';
}

export async function listRuns(factorId: string, filter: { id?: string; limit?: number; states?: RunState[]; lane?: Lane; clientId?: string; before?: {createdAt:string;id:string} } = {}): Promise<EngineRun[]> {
  await ensureEngineSchema();
  const params:unknown[]=[factorId];
  let extra='';
  if(filter.id){params.push(filter.id);extra+=' and r.id = $'+params.length;}
  if(filter.states?.length){params.push(filter.states);extra+=' and r.state = any($'+params.length+'::text[])';}
  if(filter.lane)extra+=' and '+LANE_SQL[filter.lane];
  if(filter.clientId){params.push(filter.clientId);extra+=' and r.factorcloud_client_id = $'+params.length;}
  if(filter.before){params.push(filter.before.createdAt,filter.before.id);extra+=' and (r.created_at,r.id) < ($'+(params.length-1)+'::timestamptz,$'+params.length+'::text)';}
  const rows = await query<RunRow>(`
    select r.*, to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor, c.name as client_name,
      r.facts_snapshot->'debtorCredit'->>'debtorName' as debtor_name, r.facts_snapshot->'invoice'->>'debtorId' as debtor_id from engine_runs r join portal_clients c on c.id = r.client_id
    where r.factor_id = $1 ${extra}
    order by r.created_at desc, r.id desc limit ${Math.min(filter.limit ?? 200, 500)}
  `, params);
  return rows.map((r) => ({
    id: r.id, factorCloudInvoiceId: r.factorcloud_invoice_id, factorCloudClientId: r.factorcloud_client_id, clientName: r.client_name, debtorName: r.debtor_name ?? null, debtorId: r.debtor_id ?? null,
    invoiceNumber: r.invoice_number, submissionId: r.submission_id, amount: Number(r.amount), mode: r.mode, outcome: r.outcome, state: r.state, approvalStatus:r.approval_status,
    rules: r.rules, reasons: r.reasons, detail: r.detail, invoiceGroupId: r.invoice_group_id, paymentType: r.payment_type, autoFunded: r.auto_funded,
    fundedAt: r.funded_at ? new Date(r.funded_at).toISOString() : null, createdAt: r.created_cursor || new Date(r.created_at).toISOString(),
  }));
}

/**
 * A person's click on the Funding page:
 *   approve  a suggestion, or "Try approving again": re-checks every rule first
 *   fund     an approved invoice (funds its FactorCloud batch), or an invoice held in auto-fund
 *            mode, which is approved and then funded in the same click
 */
export interface ActOptions {
  /** The batch the person reviewed: funding refuses if FactorCloud's batch no longer matches it. */
  expected?: { invoiceId: string; amount: number | null }[];
  /** The hold reasons (rule ids) the person saw when overriding a hold. */
  seenHolds?: string[];
}
export type ActResult = { ok: boolean; detail: string; approvedOnly?: boolean; batchChanged?: boolean };

export async function actOnRun(factorId: string, runId: string, action: 'approve' | 'fund', userId: string | null, reviewer: string, opts: ActOptions = {}): Promise<ActResult> {
  const [run] = await listRuns(factorId, { id: runId });
  if (!run) return { ok: false, detail: 'Not found.' };
  const date = new Date().toISOString().slice(0, 10);
  if (action === 'fund' && run.state === 'SUGGESTED' && run.mode === 'fund') {
    return withApprovalClaim(run.id, (token) => overrideHold(factorId, run, userId, reviewer, opts.seenHolds ?? [], token));
  }
  if (action === 'approve') {
    if (run.state !== 'SUGGESTED' && run.state !== 'FAILED') return { ok: false, detail: 'Already approved.' };
    return withApprovalClaim(run.id, (token) => rerunAndApprove(factorId, run, reviewer, token));
  }
  if (run.state !== 'APPROVED') return { ok: false, detail: run.state === 'FUNDED' ? 'Already funded.' : 'Approve it for funding first.' };
  // A person funds what they reviewed: the batch shown in the dialog, not whatever it holds now.
  if (!opts.expected?.length) return { ok: false, detail: 'Review the funding batch before funding it.' };
  const funded = await fund(run.id, run.paymentType, false, userId, { expected: opts.expected });
  if (funded.ok) await addNote(run.factorCloudInvoiceId, `funded by ${reviewer} on ${date}`);
  return funded;
}

/** What FactorCloud says now, and the rules run again on it. */
type Recheck = Decision & { facts: EngineFacts; amount: number; remote: RemoteState } | { error: string };

/**
 * Before anyone approves or funds by hand, read the invoice and debtor from FactorCloud again and
 * run every rule on the current numbers: an amount, debtor, No Buy flag or status may have changed
 * since the decision was recorded.
 */
async function recheck(factorId: string, run: EngineRun, settings: RuleSettings): Promise<Recheck> {
  const fresh = await settle(async () => {
    const raw = await getInvoice(run.factorCloudInvoiceId);
    const record = collectRiskInvoiceRecords(raw).find((r) => r.id === run.factorCloudInvoiceId);
    if (!record?.companyDebtorId || record.companyClientId !== run.factorCloudClientId || !Number.isFinite(record.invoiceAmount) || !record.invoiceAmount || record.invoiceAmount <= 0) return null;
    const amount = record.invoiceAmount;
    const debtor = await getCompany(record.companyDebtorId);
    const debtorCredit = await loadDebtorCredit(run.factorCloudClientId, debtor, amount, run.factorCloudInvoiceId);
    const paperwork = run.rules.some((r) => r.id === 'paperwork' && r.status === 'REVIEW') ? 'REVIEW' as const : 'PASS' as const;
    const decision = await decideNow({ factorId, invoiceId: run.factorCloudInvoiceId, clientId: run.factorCloudClientId, debtorId: record.companyDebtorId, amount, paperwork, debtorCredit }, settings);
    return { ...decision, amount, remote: remoteState(record) };
  }, 're-check');
  return fresh ?? { error: 'The invoice could not be read from FactorCloud to re-check it. Nothing was done; try again in a moment.' };
}

/** Why nothing was done: the invoice already moved on in FactorCloud. */
function remoteStop(remote: RemoteState): string {
  return remote === 'FUNDED' ? 'Nothing done: FactorCloud already shows this invoice funded.'
    : remote === 'APPROVED' ? 'Nothing done: this invoice was already approved in FactorCloud. Refresh to see it ready to fund.'
    : remote === 'REJECTED' ? 'Nothing done: this invoice was rejected in FactorCloud.'
    : 'Nothing done: FactorCloud no longer has this invoice.';
}

/** Rules that stop automatic funding: held, or couldn't be checked. */
const holdIds = (rules: RuleResult[]) => rules.filter((r) => r.status === 'HOLD' || r.status === 'UNKNOWN').map((r) => r.id);

/**
 * "Approve & fund" on an invoice held in auto-fund mode: a person overriding the hold. The rules
 * run again first. Hard stops still apply (a new paperwork or No Buy reason, a changed amount, an
 * invoice that moved on in FactorCloud), and the person may only override the reasons they saw:
 * a new reason means another look. If FactorCloud batches it with other invoices, it stops at
 * approved so the whole batch can be reviewed before paying it.
 */
async function overrideHold(factorId: string, run: EngineRun, userId: string | null, reviewer: string, seenHolds: string[], token: string): Promise<ActResult> {
  const settings = settingsForClient(await loadSettings(factorId), run.factorCloudClientId);
  const fresh = await recheck(factorId, run, settings);
  if ('error' in fresh) { await update(run.id, { detail: fresh.error }); return { ok: false, detail: fresh.error }; }
  const recorded = await query(`update engine_runs set outcome = $1, rules = $2::jsonb, reasons = $3::jsonb, settings_snapshot = $4::jsonb, facts_snapshot = $5::jsonb, updated_at = now()
    where id = $6 and approval_token = $7 and approval_status = 'CHECKING' returning id`,
    [fresh.outcome, JSON.stringify(fresh.rules), JSON.stringify(fresh.reasons), JSON.stringify(settings), JSON.stringify(fresh.facts), run.id, token]);
  if (!recorded.length) return { ok: false, detail: 'Approval claim changed. Refresh before continuing.' };
  const stop = async (detail: string, state: RunState = 'SUGGESTED') => {
    await query('update engine_runs set state = $2, detail = $3 where id = $1 and approval_token = $4', [run.id, state, detail, token]);
    return { ok: false, detail };
  };
  if (fresh.remote !== 'PENDING') return stop(remoteStop(fresh.remote));
  if (Math.abs(fresh.amount - run.amount) >= 0.005) {
    await query('update engine_runs set amount = $2 where id = $1 and approval_token = $3', [run.id, fresh.amount, token]);
    return stop(`Nothing done: the invoice amount changed in FactorCloud (${money(run.amount)} → ${money(fresh.amount)}). The rules were checked again; review it before funding.`);
  }
  if (fresh.outcome === 'REVIEW') return stop(`Not approved: ${fresh.reasons.join('; ')}`, 'REVIEW');
  const unseen = fresh.rules.filter((r) => holdIds([r]).length && !seenHolds.includes(r.id));
  if (unseen.length) return stop(`Nothing done: a new reason to hold it came up (${unseen.map((r) => r.detail).join('; ')}). Review it again.`);

  const approved = await approve({ id: run.id, invoiceId: run.factorCloudInvoiceId, clientId: run.factorCloudClientId }, settings, token);
  if ('error' in approved) { await query("update engine_runs set state='FAILED',detail=$2 where id=$1 and approval_token=$3 and state in ('SUGGESTED','FAILED')",[run.id,approved.error,token]); return { ok: false, detail: approved.error }; }
  const date = new Date().toISOString().slice(0, 10);
  const overridden = fresh.outcome === 'HOLD' ? `; hold overridden: ${fresh.reasons.join('; ')}` : '';
  await addNote(run.factorCloudInvoiceId, `approved for funding by ${reviewer} on ${date}${overridden}`);
  const funded = await fund(run.id, approved.paymentType, false, userId, { onlyIfAlone: true });
  if (funded.ok && !funded.approvedOnly) await addNote(run.factorCloudInvoiceId, `funded by ${reviewer} on ${date}`);
  return funded.ok || funded.approvedOnly ? funded : { ok: false, detail: `Approved, but not funded: ${funded.detail}` };
}

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * "Approve" on a suggestion or "Try approving again" on a failed run: runs every rule again with
 * fresh numbers first, since limits, balances and the cash reserve may have changed. If everything
 * now passes and the factor auto-funds, it is funded within the caps; otherwise it is approved and
 * held with up-to-date reasons. A new review reason (say the debtor went No Buy) stops it.
 */
async function rerunAndApprove(factorId: string, run: EngineRun, reviewer: string, token:string): Promise<{ ok: boolean; detail: string }> {
  const settings = settingsForClient(await loadSettings(factorId), run.factorCloudClientId);
  const fresh = await recheck(factorId, run, settings);
  if ('error' in fresh) {
    await update(run.id, { detail: fresh.error });
    return { ok: false, detail: fresh.error };
  }
  if (fresh.remote !== 'PENDING') {
    const detail = remoteStop(fresh.remote);
    await update(run.id, { detail });
    return { ok: false, detail };
  }
  const recorded=await query('update engine_runs set outcome = $1, rules = $2::jsonb, reasons = $3::jsonb, updated_at = now(),settings_snapshot=$6::jsonb,facts_snapshot=$7::jsonb,amount=$8 where id = $4 and approval_token=$5 and approval_status=\'CHECKING\' returning id',
    [fresh.outcome, JSON.stringify(fresh.rules), JSON.stringify(fresh.reasons), run.id,token,JSON.stringify(settings),JSON.stringify(fresh.facts),fresh.facts.invoice.amount]);
  if(!recorded.length) return {ok:false,detail:'Approval claim changed. Refresh before continuing.'};
  if (fresh.outcome === 'REVIEW') {
    const detail = `Not approved: ${fresh.reasons.join('; ')}`;
    await query("update engine_runs set state='REVIEW',detail=$2 where id=$1 and approval_token=$3",[run.id,detail,token]);
    return { ok: false, detail };
  }

  if (fresh.outcome === 'HOLD' && settings.mode === 'fund') {
    const detail = `Still held: ${fresh.reasons.join('; ')}. Use Approve & fund to fund it anyway.`;
    await query("update engine_runs set state='SUGGESTED',mode='fund',detail=$2 where id=$1 and approval_token=$3",[run.id,detail,token]);
    return { ok: true, detail };
  }
  const approved = await approve({ id: run.id, invoiceId: run.factorCloudInvoiceId, clientId: run.factorCloudClientId }, settings,token);
  if ('error' in approved) { await query("update engine_runs set state='FAILED',detail=$2 where id=$1 and approval_token=$3 and state in ('SUGGESTED','FAILED')",[run.id,approved.error,token]); return { ok: false, detail: approved.error }; }
  const autoFund = fresh.outcome === 'FUND' && settings.mode === 'fund';
  await query("update engine_runs set detail=$2 where id=$1 and state='APPROVED'", [run.id,
    fresh.outcome === 'HOLD' ? `Approved for funding by ${reviewer}; waiting for a person to fund it.` : `Approved for funding by ${reviewer}.`]);
  const date = new Date().toISOString().slice(0, 10);
  if (autoFund) {
    const funded = await fund(run.id, approved.paymentType, true, null);
    await addNote(run.factorCloudInvoiceId, funded.ok
      ? `approved for funding by ${reviewer} on ${date} and funded automatically: every funding rule passed on a fresh check`
      : `approved for funding by ${reviewer} on ${date}; funding did not go through: ${funded.detail}`);
    return funded.ok ? { ok: true, detail: 'Every rule passes now: approved and funded.' } : { ok: false, detail: `Approved, but funding did not go through: ${funded.detail}` };
  }
  await addNote(run.factorCloudInvoiceId, fresh.outcome === 'HOLD'
    ? `approved for funding by ${reviewer} on ${date}; funding on hold: ${fresh.reasons.join('; ')}`
    : `approved for funding by ${reviewer} on ${date}`);
  return { ok: true, detail: fresh.outcome === 'HOLD' ? `Approved for funding. Held for a person to fund: ${fresh.reasons.join('; ')}` : 'Approved for funding.' };
}
