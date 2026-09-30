import 'server-only';

import { randomUUID } from 'crypto';
import { claimFunding, fundingReservationResult } from './funding-safety';
import { openRecovery } from './recovery';
import { query, pool } from './db';
import type { DebtorCredit } from './credit';
import { loadDebtorCredit } from './debtor-credit';
import { getCompany, getInvoice, listInvoices, updateInvoiceNotes } from './factorcloud';
import { approveForFunding, FUNDABLE_PAYMENT_TYPES, fundInvoiceGroups, getCashReserveBalance, getClientCreditLimit, listFundingInstructions, pickFundingInstruction, verifyInvoices } from './funding-api';
import { portalUpdateNote } from './portal-notes';
import { collectRiskInvoiceRecords, type RiskInvoiceRecord } from './risk';
import { decide, type Decision, type RuleResult, type EngineFacts } from './rules/engine';
import { DEFAULT_SETTINGS, normalizeSettings, type RuleSettings } from './rules/settings';
import { ensureEngineSchema } from './schema';

// Runs the factor's rules on a newly sent invoice and acts on the result in FactorCloud, as far as
// the factor's mode allows:
//   suggest  record what the engine would do; people do everything
//   approve  verify and approve for funding (FUND and HOLD alike); people click Fund
//   fund     also fund invoices that pass every rule and cap (FUND)
// Every step is recorded in engine_runs. Nothing here throws into the send step: the invoice is
// already created, and a failure leaves it for a person.

export type RunState = 'SUGGESTED' | 'REVIEW' | 'APPROVED' | 'FUNDING' | 'FUNDED' | 'FAILED';

export interface EngineRun {
  id: string;
  factorCloudInvoiceId: string;
  factorCloudClientId: string;
  clientName: string | null;
  invoiceNumber: string | null;
  submissionId: string | null;
  amount: number;
  mode: string;
  outcome: Decision['outcome'];
  state: RunState;
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

/** The settings for the signed-in factor, or null when the engine can't run (no database sign-in). */
export async function engineSettingsFor(factorId: string | null | undefined): Promise<RuleSettings | null> {
  if (!factorId) return null;
  try { return await loadSettings(factorId); } catch (err) { console.error('[funding-engine] settings', err); return null; }
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
async function approve(run: { id: string; invoiceId: string; clientId: string }, settings: RuleSettings): Promise<{ groupId: string; paymentType: string | null } | { error: string }> {
  const instructions = await settle(() => listFundingInstructions(run.clientId), 'funding instructions');
  if (!instructions) return { error: "The client's funding instructions could not be read." };
  const instruction = pickFundingInstruction(instructions);
  if (!instruction) return { error: 'The client has no funding instruction in FactorCloud, so it cannot be approved for funding.' };
  try {
    if (settings.markVerified) await verifyInvoices([run.invoiceId], 'Checked by the FactorCloud client portal: the documents match the invoice.');
    const groups = await approveForFunding(run.clientId, instruction.id, [run.invoiceId]);
    const group = groups[0];
    if (!group) return { error: 'FactorCloud approved the invoice but returned no funding batch.' };
    return { groupId: group.id, paymentType: group.paymentType ?? instruction.paymentMethod ?? null };
  } catch (err) {
    return { error: `FactorCloud refused: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Funds a batch. Only one caller gets past the APPROVED → FUNDING switch, so a double click can't fund twice. */
async function fund(runId: string, groupId: string, paymentType: string | null, auto: boolean, userId: string | null): Promise<{ ok: boolean; detail: string }> {
  if (!paymentType || !(FUNDABLE_PAYMENT_TYPES as readonly string[]).includes(paymentType)) {
    const detail = `The client's payment method (${paymentType ?? 'none'}) can't be funded through the API. Fund it in FactorCloud.`;
    await update(runId, { detail });
    return { ok: false, detail };
  }
  const [owner] = await query<{factor_id:string;submission_id:string|null}>('select factor_id,submission_id from engine_runs where id=$1',[runId]);
  if (!owner || !await claimFunding(runId, auto, await loadSettings(owner.factor_id))) return { ok: false, detail: 'Already funded, being reconciled, or held by the current funding cap.' };
  try {
    // The same batch always gets the same transaction ID, so FactorCloud can refuse a repeat.
    await fundInvoiceGroups([groupId], paymentType, `portal-fund-${groupId}`);
    await fundingReservationResult(runId, 'CONFIRMED');
    await update(runId, { state: 'FUNDED', auto_funded: auto, funded: true, funded_by_user_id: auto ? null : userId, detail: auto ? 'Funded automatically: every rule passed.' : 'Funded.' });
    return { ok: true, detail: 'Funded.' };
  } catch (err) {
    const detail = `Funding failed: ${err instanceof Error ? err.message : String(err)}. Check the batch in FactorCloud before trying again.`;
    await update(runId, { state: 'FUNDING', detail });
    await fundingReservationResult(runId, 'UNKNOWN');
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
    const settings = await loadSettings(input.factorId);
    if (settings.mode === 'off') return null;
    const decision = await decideNow(input, settings);

    const runId = `run_${randomUUID()}`;
    const initial: RunState = decision.outcome === 'REVIEW' ? 'REVIEW' : settings.mode === 'suggest' ? 'SUGGESTED' : 'FAILED';
    await query(`
      insert into engine_runs (id, factor_id, client_id, submission_id, factorcloud_invoice_id, factorcloud_client_id, invoice_number, amount, mode, outcome, state, rules, reasons)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
    `, [runId, input.factorId, input.portalClientId, input.submissionId, input.invoiceId, input.clientId, input.invoiceNumber, input.amount, settings.mode, decision.outcome, initial, JSON.stringify(decision.rules), JSON.stringify(decision.reasons)]);

    await query('update engine_runs set settings_snapshot=$2::jsonb,facts_snapshot=$3::jsonb where id=$1',[runId,JSON.stringify(settings),JSON.stringify(decision.facts)]);

    if (decision.outcome !== 'REVIEW' && settings.mode !== 'suggest') {
      const approved = await approve({ id: runId, invoiceId: input.invoiceId, clientId: input.clientId }, settings);
      if ('error' in approved) {
        await update(runId, { state: 'FAILED', detail: approved.error });
      } else {
        await update(runId, { state: 'APPROVED', invoice_group_id: approved.groupId, payment_type: approved.paymentType, detail: decision.outcome === 'HOLD' ? 'Approved for funding; waiting for a person to fund it.' : 'Approved for funding.' });
        if (decision.outcome === 'FUND' && settings.mode === 'fund') {
          const funded = await fund(runId, approved.groupId, approved.paymentType, true, null);
          await addNote(input.invoiceId, funded.ok ? 'approved and funded automatically: every funding rule passed' : `approved for funding automatically; funding did not go through: ${funded.detail}`);
        } else {
          await addNote(input.invoiceId, decision.outcome === 'HOLD'
            ? `approved for funding automatically; funding on hold: ${decision.reasons.join('; ')}`
            : 'approved for funding automatically: every funding rule passed');
        }
      }
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
  invoice_group_id: string | null; payment_type: string | null; auto_funded: boolean; funded_at: Date | string | null; created_at: Date | string;
};

export async function listRuns(factorId: string, filter: { id?: string; limit?: number } = {}): Promise<EngineRun[]> {
  await ensureEngineSchema();
  const rows = await query<RunRow>(`
    select r.*, c.name as client_name from engine_runs r join portal_clients c on c.id = r.client_id
    where r.factor_id = $1 ${filter.id ? 'and r.id = $2' : ''}
    order by r.created_at desc limit ${Math.min(filter.limit ?? 200, 500)}
  `, filter.id ? [factorId, filter.id] : [factorId]);
  return rows.map((r) => ({
    id: r.id, factorCloudInvoiceId: r.factorcloud_invoice_id, factorCloudClientId: r.factorcloud_client_id, clientName: r.client_name,
    invoiceNumber: r.invoice_number, submissionId: r.submission_id, amount: Number(r.amount), mode: r.mode, outcome: r.outcome, state: r.state,
    rules: r.rules, reasons: r.reasons, detail: r.detail, invoiceGroupId: r.invoice_group_id, paymentType: r.payment_type, autoFunded: r.auto_funded,
    fundedAt: r.funded_at ? new Date(r.funded_at).toISOString() : null, createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** A person's click on the Funding page: approve a suggestion, or fund an approved invoice. */
export async function actOnRun(factorId: string, runId: string, action: 'approve' | 'fund', userId: string | null, reviewer: string): Promise<{ ok: boolean; detail: string }> {
  const [run] = await listRuns(factorId, { id: runId });
  if (!run) return { ok: false, detail: 'Not found.' };
  if (action === 'approve') {
    if (run.state !== 'SUGGESTED' && run.state !== 'FAILED') return { ok: false, detail: 'Already approved.' };
    return rerunAndApprove(factorId, run, reviewer);
  }
  if (run.state !== 'APPROVED' || !run.invoiceGroupId) return { ok: false, detail: run.state === 'FUNDED' ? 'Already funded.' : 'Approve it for funding first.' };
  const funded = await fund(run.id, run.invoiceGroupId, run.paymentType, false, userId);
  if (funded.ok) await addNote(run.factorCloudInvoiceId, `funded by ${reviewer} on ${new Date().toISOString().slice(0, 10)}`);
  return funded;
}


/**
 * "Approve" on a suggestion or "Try approving again" on a failed run: runs every rule again with
 * fresh numbers first, since limits, balances and the cash reserve may have changed. If everything
 * now passes and the factor auto-funds, it is funded within the caps; otherwise it is approved and
 * held with up-to-date reasons. A new review reason (say the debtor went No Buy) stops it.
 */
async function rerunAndApprove(factorId: string, run: EngineRun, reviewer: string): Promise<{ ok: boolean; detail: string }> {
  const settings = await loadSettings(factorId);
  const fresh = await settle(async () => {
    const raw = await getInvoice(run.factorCloudInvoiceId);
    const record = collectRiskInvoiceRecords(raw).find((r) => r.id === run.factorCloudInvoiceId);
    if (!record?.companyDebtorId) return null;
    const amount = record.invoiceAmount && record.invoiceAmount > 0 ? record.invoiceAmount : run.amount;
    const debtor = await getCompany(record.companyDebtorId);
    const debtorCredit = await loadDebtorCredit(run.factorCloudClientId, debtor, amount, run.factorCloudInvoiceId);
    const paperwork = run.rules.some((r) => r.id === 'paperwork' && r.status === 'REVIEW') ? 'REVIEW' as const : 'PASS' as const;
    return decideNow({ factorId, invoiceId: run.factorCloudInvoiceId, clientId: run.factorCloudClientId, debtorId: record.companyDebtorId, amount, paperwork, debtorCredit }, settings);
  }, 're-run rules');
  if (!fresh) {
    const detail = 'The invoice could not be read from FactorCloud to re-check the rules. Try again in a moment.';
    await update(run.id, { detail });
    return { ok: false, detail };
  }
  await query('update engine_runs set outcome = $1, rules = $2::jsonb, reasons = $3::jsonb, updated_at = now() where id = $4',
    [fresh.outcome, JSON.stringify(fresh.rules), JSON.stringify(fresh.reasons), run.id]);
  await query('update engine_runs set settings_snapshot=$2::jsonb,facts_snapshot=$3::jsonb,amount=$4 where id=$1',[run.id,JSON.stringify(settings),JSON.stringify(fresh.facts),fresh.facts.invoice.amount]);
  if (fresh.outcome === 'REVIEW') {
    const detail = `Not approved: ${fresh.reasons.join('; ')}`;
    await update(run.id, { state: 'REVIEW', detail });
    return { ok: false, detail };
  }

  const approved = await approve({ id: run.id, invoiceId: run.factorCloudInvoiceId, clientId: run.factorCloudClientId }, settings);
  if ('error' in approved) { await update(run.id, { state: 'FAILED', detail: approved.error }); return { ok: false, detail: approved.error }; }
  const autoFund = fresh.outcome === 'FUND' && settings.mode === 'fund';
  await update(run.id, {
    state: 'APPROVED', invoice_group_id: approved.groupId, payment_type: approved.paymentType,
    detail: fresh.outcome === 'HOLD' ? `Approved for funding by ${reviewer}; waiting for a person to fund it.` : `Approved for funding by ${reviewer}.`,
  });
  const date = new Date().toISOString().slice(0, 10);
  if (autoFund) {
    const funded = await fund(run.id, approved.groupId, approved.paymentType, true, null);
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
