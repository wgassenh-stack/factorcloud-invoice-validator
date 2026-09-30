// The funding engine in demo mode: the real rules (lib/rules/engine.ts) run on the demo portfolio,
// so every lane can be shown without FactorCloud or a database: funded automatically, approved and
// held for a click, sent to paperwork review, and a failed approval. New demo submissions go
// through the same rules. Everything lives in memory for the life of the server process, like the
// rest of demo mode, and nothing is sent anywhere.

import { openArBalance } from './analytics';
import type { DebtorCredit } from './credit';
import { DEMO_CLIENT_ID } from './demo';
import type { DemoInvoice } from './demo-data';
import { addDemoInvoice, demoClientDebtor, demoCompany, demoInvoices, demoReviews } from './demo-store';
import type { EngineRun, RunState } from './funding-engine';
import type { FundingData, FundingSummary } from './operations-view';
import { collectRiskInvoiceRecords, type RiskInvoiceRecord } from './risk';
import { decide, type Decision, type EngineFacts } from './rules/engine';
import { DEFAULT_SETTINGS, normalizeSettings, overrideFrom, settingsForClient, type RuleSettings } from './rules/settings';

const TIME_ZONE = 'America/Chicago';
/** The factor's calendar day for a timestamp. */
const dayOf = (at: string | number | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(at));
const MINUTE = 60_000;

interface DemoFundingState { settings: RuleSettings; runs: EngineRun[]; seq: number }
const globalState = globalThis as unknown as { __fcDemoFunding?: DemoFundingState };

/** The demo factor auto-funds, with two clients set up differently to show per-client rules. */
function seedSettings(): RuleSettings {
  const base = normalizeSettings({ ...DEFAULT_SETTINGS, mode: 'fund', caps: { ...DEFAULT_SETTINGS.caps, perFactorPerDay: 75_000 } });
  const bigClient = demoCompany('demo-client-02');
  const newClient = demoCompany('demo-client-20');
  if (bigClient) base.clientOverrides['demo-client-02'] = { ...overrideFrom(base, bigClient.companyName ?? 'Lone Star Haulers Inc'), caps: { perInvoice: 15_000, perClientPerDay: 60_000 } };
  if (newClient) base.clientOverrides['demo-client-20'] = { ...overrideFrom(base, newClient.companyName ?? 'Midway Motor Lines'), mode: 'suggest' };
  return base;
}

function state(): DemoFundingState {
  if (!globalState.__fcDemoFunding) {
    const s: DemoFundingState = { settings: seedSettings(), runs: [], seq: 0 };
    globalState.__fcDemoFunding = s;
    seedRuns(s);
  }
  return globalState.__fcDemoFunding;
}

const records = (invoices: DemoInvoice[]): RiskInvoiceRecord[] => collectRiskInvoiceRecords(invoices);

function fundedToday(s: DemoFundingState, clientId: string): { client: number; factor: number } {
  const day = dayOf(Date.now());
  const today = s.runs.filter((r) => r.autoFunded && r.fundedAt && dayOf(r.fundedAt) === day);
  return { client: today.filter((r) => r.factorCloudClientId === clientId).reduce((t, r) => t + r.amount, 0), factor: today.reduce((t, r) => t + r.amount, 0) };
}

/** The same facts the live engine gathers from FactorCloud, read from the demo portfolio. */
function factsFor(s: DemoFundingState, invoice: { id: string; amount: number; clientId: string; debtorId: string }, paperwork: 'PASS' | 'REVIEW', now: Date, tweak: Partial<EngineFacts> = {}): EngineFacts {
  const all = demoInvoices();
  const clientRecords = records(all.filter((i) => i.companyClientId === invoice.clientId && i.id !== invoice.id));
  const debtorRecords = records(all.filter((i) => i.companyDebtorId === invoice.debtorId && i.id !== invoice.id));
  const terms = demoClientDebtor(invoice.clientId, invoice.debtorId);
  const debtor = demoCompany(invoice.debtorId);
  const owed = clientRecords.filter((r) => r.companyDebtorId === invoice.debtorId).map(openArBalance).filter((b) => b > 0);
  const debtorCredit: DebtorCredit = {
    debtorId: invoice.debtorId, debtorName: debtor?.companyName || invoice.debtorId, noBuy: debtor?.noBuy === true,
    limit: terms?.creditLimit ?? null, approved: terms?.creditLimitApproved ?? null, rating: terms?.creditRating ?? null,
    openBalance: owed.reduce((t, b) => t + b, 0), openCount: owed.length, thisInvoice: invoice.amount,
  };
  return {
    invoice, paperwork, debtorCredit, clientCreditLimit: null, clientRecords, debtorRecords,
    cashReserve: 2_450, fundedToday: fundedToday(s, invoice.clientId), now, timeZone: TIME_ZONE, ...tweak,
  };
}

function record(s: DemoFundingState, invoice: DemoInvoice, decision: Decision, mode: RuleSettings['mode'], state: RunState, createdAt: Date, extra: Partial<EngineRun> = {}): EngineRun {
  s.seq += 1;
  const funded = state === 'FUNDED';
  const run: EngineRun = {
    id: `demo-run-${String(s.seq).padStart(3, '0')}`,
    factorCloudInvoiceId: invoice.id, factorCloudClientId: invoice.companyClientId, clientName: invoice.companyClientName,
    debtorName: invoice.companyDebtorName, debtorId: invoice.companyDebtorId, invoiceNumber: invoice.invoiceNumber, submissionId: null,
    amount: invoice.invoiceAmount, mode, outcome: decision.outcome, state, rules: decision.rules, reasons: decision.reasons,
    detail: state === 'FUNDED' ? 'Funded automatically: every rule passed.' : state === 'APPROVED' ? 'Approved for funding; waiting for a person to fund it.' : state === 'REVIEW' ? 'Paperwork needs a person before approval.' : state === 'SUGGESTED' ? (mode === 'fund' ? 'Held for one click. Not approved in FactorCloud yet, so it stays out of other invoices\' funding batches.' : 'Suggest only for this client: a person approves.') : null,
    invoiceGroupId: state === 'APPROVED' || funded ? `demo-group-${s.seq}` : null, paymentType: 'ACH', autoFunded: funded,
    fundedAt: funded ? new Date(createdAt.getTime() + (45 + (s.seq * 37) % 150) * 1000).toISOString() : null,
    createdAt: createdAt.toISOString(), ...extra,
  };
  s.runs.unshift(run);
  syncInvoice(run);
  return run;
}

/** Lane an engine decision lands in, given the client's mode. */
function laneFor(decision: Decision, mode: RuleSettings['mode']): RunState {
  if (decision.outcome === 'REVIEW') return 'REVIEW';
  if (mode === 'suggest') return 'SUGGESTED';
  // Like live: in auto-fund mode a held invoice waits in the portal, not approved in FactorCloud.
  if (mode === 'fund') return decision.outcome === 'FUND' ? 'FUNDED' : 'SUGGESTED';
  return 'APPROVED';
}

/**
 * Today's decisions, planted so every lane has a real example. Each one is the engine's actual
 * decision on demo facts; the only staged facts are the ones named (a negative reserve, a low
 * credit limit, a paperwork flag, FactorCloud refusing an approval).
 */
function seedRuns(s: DemoFundingState): void {
  const now = Date.now();
  const pending = demoInvoices().filter((i) => i.status === 'PENDING' || i.status === 'APPROVED').sort((a, b) => b.createdOn.localeCompare(a.createdOn));
  // Invoices already in the paperwork review queue only appear as paperwork reviews.
  const inReview = new Set(demoReviews().filter((r) => r.status === 'OPEN').map((r) => r.invoiceId));
  const used = new Set<string>();
  // Spread over the last couple of hours, so they are all today's work.
  let minutesAgo = 6;
  const take = (want: (i: DemoInvoice) => boolean, scenario: (i: DemoInvoice, at: Date) => boolean) => {
    for (const invoice of pending) {
      if (used.has(invoice.id) || !want(invoice)) continue;
      if (inReview.has(invoice.id) !== (want === reviewed)) continue;
      const at = new Date(now - minutesAgo * MINUTE);
      if (!scenario(invoice, at)) continue;
      used.add(invoice.id);
      minutesAgo += 5 + (used.size * 7) % 9;
      return;
    }
  };
  const input = (i: DemoInvoice) => ({ id: i.id, amount: i.invoiceAmount, clientId: i.companyClientId, debtorId: i.companyDebtorId });
  const run = (i: DemoInvoice, at: Date, opts: { paperwork?: 'PASS' | 'REVIEW'; tweak?: Partial<EngineFacts>; expect: Decision['outcome'] | ((d: Decision) => boolean); failed?: string }) => {
    const settings = settingsForClient(s.settings, i.companyClientId);
    const decision = decide(factsFor(s, input(i), opts.paperwork ?? 'PASS', at, opts.tweak), settings);
    if (typeof opts.expect === 'function' ? !opts.expect(decision) : decision.outcome !== opts.expect) return false;
    if (opts.failed) record(s, i, decision, settings.mode, 'FAILED', at, { detail: opts.failed });
    else record(s, i, decision, settings.mode, laneFor(decision, settings.mode), at);
    return true;
  };
  const small = (i: DemoInvoice) => i.invoiceAmount <= 4_800;
  const reviewed = (i: DemoInvoice) => inReview.has(i.id);
  const plain = (i: DemoInvoice) => small(i) && !s.settings.clientOverrides[i.companyClientId];

  // Held: over the per-invoice cap (a staffing invoice), but the client's special caps let one through.
  take((i) => i.invoiceAmount > 5_000 && !s.settings.clientOverrides[i.companyClientId], (i, at) => run(i, at, { expect: (d) => d.outcome === 'HOLD' && d.rules.some((r) => r.id === 'cap-invoice' && r.status === 'HOLD') }));
  // The biggest client has its own higher caps: a large invoice from its main debtor is funded anyway.
  const lsh = demoInvoices().filter((i) => i.companyClientId === 'demo-client-02');
  const mainDebtor = [...lsh.reduce((m, i) => m.set(i.companyDebtorId, (m.get(i.companyDebtorId) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (mainDebtor) {
    const big = addDemoInvoice({ invoiceNumber: 'LSH-11241', referenceNumber: 'LD448402', companyClientId: 'demo-client-02', companyDebtorId: mainDebtor, invoiceAmount: 8_750, invoiceDate: dayOf(now), notes: null });
    pending.unshift(big);
    take((i) => i.id === big.id, (i, at) => run(i, at, { expect: 'FUND' }));
  }
  // Funded with no one touching them.
  for (let n = 0; n < 6; n++) take(plain, (i, at) => run(i, at, { expect: 'FUND' }));
  // Held: negative cash reserve.
  take(plain, (i, at) => run(i, at, { tweak: { cashReserve: -1_840 }, expect: (d) => d.outcome === 'HOLD' && d.reasons.length === 1 }));
  // Held: over the debtor credit limit.
  take(plain, (i, at) => {
    const facts = factsFor(s, input(i), 'PASS', at);
    const tight = facts.debtorCredit ? { ...facts.debtorCredit, limit: Math.max(5_000, Math.round((facts.debtorCredit.openBalance + i.invoiceAmount - 1_200) / 1_000) * 1_000), approved: true } : null;
    return run(i, at, { tweak: { debtorCredit: tight }, expect: (d) => d.outcome === 'HOLD' && d.reasons.length === 1 && d.rules.some((r) => r.id === 'credit-limit' && r.status === 'HOLD') });
  });
  // Held by a debtor risk rule the portfolio really trips (slow payer, concentration or first invoice).
  take(small, (i, at) => run(i, at, { expect: (d) => d.outcome === 'HOLD' && d.rules.some((r) => ['slow-debtor', 'concentration', 'new-debtor'].includes(r.id) && r.status === 'HOLD') }));
  // Paperwork sent anyway: never approved automatically.
  take(reviewed, (i, at) => run(i, at, { paperwork: 'REVIEW', expect: 'REVIEW' }));
  // A client on "suggest only".
  take((i) => i.companyClientId === 'demo-client-20', (i, at) => run(i, at, { expect: (d) => d.outcome !== 'REVIEW' }));
  // FactorCloud refused the approval.
  take(plain, (i, at) => run(i, at, { expect: 'FUND', failed: 'FactorCloud refused: the client has no funding instruction set up, so it cannot be approved for funding.' }));
  s.runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function demoFundingSettings(): RuleSettings {
  return state().settings;
}

export function saveDemoFundingSettings(settings: unknown): RuleSettings {
  const s = state();
  s.settings = normalizeSettings(settings);
  return s.settings;
}

/** A new demo submission goes through the rules, like a live one. */
export function runDemoFundingEngine(invoice: DemoInvoice, paperwork: 'PASS' | 'REVIEW'): EngineRun | null {
  const s = state();
  const settings = settingsForClient(s.settings, invoice.companyClientId);
  if (settings.mode === 'off') return null;
  const now = new Date();
  const decision = decide(factsFor(s, { id: invoice.id, amount: invoice.invoiceAmount, clientId: invoice.companyClientId, debtorId: invoice.companyDebtorId }, paperwork, now), settings);
  const run = record(s, invoice, decision, settings.mode, laneFor(decision, settings.mode), now);
  if (run.state === 'FUNDED') { run.fundedAt = new Date(now.getTime() + 2_000).toISOString(); syncInvoice(run); }
  return run;
}

/** Keeps the demo invoice's status in step with the engine, so the client side sees it funded. */
function syncInvoice(run: EngineRun): void {
  const invoice = demoInvoices().find((i) => i.id === run.factorCloudInvoiceId);
  if (!invoice) return;
  if (run.state === 'FUNDED') { invoice.status = 'FUNDED'; invoice.verificationStatus = 'VERIFIED'; invoice.fundedDate = run.fundedAt; invoice.advanceAmount = Math.round(invoice.invoiceAmount * 0.9 * 100) / 100; }
  else if (run.state === 'APPROVED') { invoice.status = 'APPROVED'; invoice.verificationStatus = 'VERIFIED'; }
}

/** The Funding Center lane, as the live engine's laneOf(). */
function laneOf(run: EngineRun): string {
  if (run.state === 'SUGGESTED') return run.mode === 'fund' ? 'decision' : 'suggestions';
  return run.state === 'APPROVED' ? 'decision' : run.state === 'FUNDED' ? 'funded' : run.state === 'REVIEW' ? 'review' : 'exceptions';
}

export function demoFundingData(lane: string | null): FundingData {
  const s = state();
  const runs = lane ? s.runs.filter((r) => laneOf(r) === lane) : s.runs;
  return { available: true, mode: s.settings.mode, runs, summary: demoSummary(s), next: null, canAct: true };
}

function demoSummary(s: DemoFundingState): FundingSummary {
  const day = dayOf(Date.now());
  const count = (states: RunState[]) => s.runs.filter((r) => states.includes(r.state));
  const autoToday = s.runs.filter((r) => r.autoFunded && r.fundedAt && dayOf(r.fundedAt) === day);
  const today = s.runs.filter((r) => dayOf(r.createdAt) === day);
  const seconds = autoToday.map((r) => (Date.parse(r.fundedAt!) - Date.parse(r.createdAt)) / 1000);
  return {
    approved: s.runs.filter((r) => laneOf(r) === 'decision').length, approvedAmount: s.runs.filter((r) => laneOf(r) === 'decision').reduce((t, r) => t + r.amount, 0),
    suggested: s.runs.filter((r) => laneOf(r) === 'suggestions').length, failed: count(['FAILED']).length, uncertain: count(['FUNDING']).length,
    funded: count(['FUNDED']).length, review: count(['REVIEW']).length, autoToday: autoToday.length,
    autoTodayAmount: autoToday.reduce((t, r) => t + r.amount, 0), timeZone: TIME_ZONE,
    today: {
      received: today.length, autoFunded: today.filter((r) => r.state === 'FUNDED' && r.autoFunded).length,
      autoAmount: today.filter((r) => r.state === 'FUNDED' && r.autoFunded).reduce((t, r) => t + r.amount, 0),
      held: today.filter((r) => r.state === 'APPROVED' || r.state === 'SUGGESTED').length, review: today.filter((r) => r.state === 'REVIEW').length,
      problems: today.filter((r) => r.state === 'FAILED' || r.state === 'FUNDING').length,
      secondsToFund: seconds.length ? seconds.reduce((t, n) => t + n, 0) / seconds.length : null,
    },
  };
}

export function demoRun(id: string): EngineRun | null {
  return state().runs.find((r) => r.id === id) ?? null;
}

/** A click on the demo Funding Center. Approving re-runs the rules first, as the live engine does. */
export function actOnDemoRun(id: string, action: 'approve' | 'fund', reviewer: string): { ok: boolean; detail: string } {
  const s = state();
  const run = s.runs.find((r) => r.id === id);
  if (!run) return { ok: false, detail: 'Not found.' };
  if (action === 'fund') {
    const held = run.state === 'SUGGESTED' && run.mode === 'fund';
    if (run.state !== 'APPROVED' && !held) return { ok: false, detail: run.state === 'FUNDED' ? 'Already funded.' : 'Approve it for funding first.' };
    Object.assign(run, { state: 'FUNDED', autoFunded: false, fundedAt: new Date().toISOString(), detail: held ? `Approved and funded by ${reviewer}.` : `Funded by ${reviewer}.` });
    syncInvoice(run);
    return { ok: true, detail: 'Funded.' };
  }
  if (run.state !== 'SUGGESTED' && run.state !== 'FAILED') return { ok: false, detail: 'Already approved.' };
  const settings = settingsForClient(s.settings, run.factorCloudClientId);
  const paperwork = run.rules.some((r) => r.id === 'paperwork' && r.status === 'REVIEW') ? 'REVIEW' : 'PASS';
  const decision = decide(factsFor(s, { id: run.factorCloudInvoiceId, amount: run.amount, clientId: run.factorCloudClientId, debtorId: run.debtorId ?? '' }, paperwork, new Date()), settings);
  Object.assign(run, { outcome: decision.outcome, rules: decision.rules, reasons: decision.reasons, invoiceGroupId: run.invoiceGroupId ?? `demo-group-${run.id}` });
  if (decision.outcome === 'REVIEW') { Object.assign(run, { state: 'REVIEW', detail: `Not approved: ${decision.reasons.join('; ')}` }); return { ok: false, detail: run.detail! }; }
  if (decision.outcome === 'FUND' && settings.mode === 'fund') {
    Object.assign(run, { state: 'FUNDED', autoFunded: true, fundedAt: new Date().toISOString(), detail: `Approved by ${reviewer} and funded automatically: every rule passes now.` });
    syncInvoice(run);
    return { ok: true, detail: 'Every rule passes now: approved and funded.' };
  }
  if (decision.outcome === 'HOLD' && settings.mode === 'fund') {
    Object.assign(run, { state: 'SUGGESTED', mode: 'fund', detail: `Still held: ${decision.reasons.join('; ')}. Use Approve & fund to fund it anyway.` });
    return { ok: true, detail: run.detail! };
  }
  Object.assign(run, { state: 'APPROVED', detail: `Approved for funding by ${reviewer}.` });
  syncInvoice(run);
  return { ok: true, detail: decision.outcome === 'HOLD' ? `Approved for funding. Held for a person to fund: ${decision.reasons.join('; ')}` : 'Approved for funding.' };
}

/** Demo client list for the per-client rules. */
export function demoFundingClients(): { id: string; name: string }[] {
  const ids = [...new Set(demoInvoices().map((i) => i.companyClientId))];
  return ids.map((id) => ({ id, name: demoCompany(id)?.companyName || id })).sort((a, b) => (a.id === DEMO_CLIENT_ID ? -1 : b.id === DEMO_CLIENT_ID ? 1 : a.name.localeCompare(b.name)));
}

/** Paperwork cleared in the demo review queue: like live, the run goes back before an admin. */
export function demoPaperworkCleared(invoiceId: string): void {
  const run = state().runs.find((r) => r.factorCloudInvoiceId === invoiceId && r.state === 'REVIEW');
  if (!run) return;
  Object.assign(run, {
    state: 'SUGGESTED', outcome: 'HOLD', detail: 'Paperwork cleared. An admin must recheck and approve funding.',
    rules: run.rules.map((r) => r.id === 'paperwork' ? { ...r, status: 'PASS', detail: 'Paperwork cleared by a reviewer; funding rules will be rechecked on approval.' } : r),
    reasons: run.reasons.filter((r) => !/review queue/.test(r)),
  });
}
