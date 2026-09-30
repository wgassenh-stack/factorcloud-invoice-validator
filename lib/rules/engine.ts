// The funding engine's decision: given what FactorCloud and the portal know about a newly created
// invoice, which lane does it go in?
//   FUND    every rule passes and it's within the auto-funding caps: approve and fund it.
//   HOLD    the invoice is fine, but a money rule tripped (or couldn't be checked): approve it for
//           funding and wait for a person to click Fund.
//   REVIEW  the paperwork needs a person (sent anyway), or the debtor is No Buy: leave it pending.
// Pure: the facts are gathered elsewhere, so every rule can be tested with plain data.

import { isClosedOut, openArBalance } from '../analytics';
import { creditAfter, type DebtorCredit } from '../credit';
import type { RiskInvoiceRecord } from '../risk';
import type { RuleSettings } from './settings';

export type Outcome = 'FUND' | 'HOLD' | 'REVIEW';
export type RuleStatus = 'PASS' | 'HOLD' | 'REVIEW' | 'SKIP' | 'UNKNOWN';

export interface RuleResult {
  id: string;
  label: string;
  status: RuleStatus;
  detail: string;
  /** Caps only limit automatic funding; a tripped cap still leaves the invoice approved. */
  cap?: boolean;
}

export interface EngineFacts {
  invoice: { id: string; amount: number; clientId: string; debtorId: string };
  /** The portal's paperwork result after sending: PASS, or REVIEW when sent anyway. */
  paperwork: 'PASS' | 'REVIEW';
  debtorCredit: DebtorCredit | null;
  /** The client's credit limit in FactorCloud; null when none is set, undefined when it couldn't be read. */
  clientCreditLimit: number | null | undefined;
  /** Every invoice of this client (null when the list couldn't be read). */
  clientRecords: RiskInvoiceRecord[] | null;
  /** Every invoice owed by this debtor, across clients (null when unreadable). */
  debtorRecords: RiskInvoiceRecord[] | null;
  /** The client's cash reserve balance (null when unreadable). */
  cashReserve: number | null;
  /** Already auto-funded today (null when unreadable). */
  fundedToday: { client: number; factor: number } | null;
  now: Date;
  timeZone?: string;
}

export interface Decision {
  outcome: Outcome;
  rules: RuleResult[];
  /** Plain-language reasons the invoice isn't auto-funded (empty for FUND). */
  reasons: string[];
}

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const DAY = 86_400_000;
const dateOf = (record: RiskInvoiceRecord) => Date.parse(String(record.createdOn ?? record.invoiceDate ?? '').slice(0, 10));

export function decide(facts: EngineFacts, settings: RuleSettings): Decision {
  const { rules: cfg, caps } = settings;
  const amount = facts.invoice.amount;
  const others = (records: RiskInvoiceRecord[] | null) => records?.filter((r) => r.id !== facts.invoice.id && !isClosedOut(r)) ?? null;
  const clientRecords = others(facts.clientRecords);
  const debtorRecords = others(facts.debtorRecords);
  const results: RuleResult[] = [];
  const add = (r: RuleResult) => results.push(r);
  const off = (id: string, label: string) => add({ id, label, status: 'SKIP', detail: 'Rule switched off.' });

  add(facts.paperwork === 'PASS'
    ? { id: 'paperwork', label: 'Paperwork', status: 'PASS', detail: 'Every document check passed.' }
    : { id: 'paperwork', label: 'Paperwork', status: 'REVIEW', detail: 'Sent anyway with a note: it needs a person in the review queue.' });

  // Debtor
  const credit = facts.debtorCredit;
  if (credit?.noBuy) add({ id: 'no-buy', label: 'Debtor buy status', status: 'REVIEW', detail: `FactorCloud marks ${credit.debtorName} No Buy.` });
  if (!cfg.creditLimit.enabled) off('credit-limit', 'Debtor credit limit');
  else if (!credit || credit.lookupFailed) add({ id: 'credit-limit', label: 'Debtor credit limit', status: 'UNKNOWN', detail: 'The credit limit could not be checked.' });
  else if (!credit.limit || credit.limit <= 0) add({ id: 'credit-limit', label: 'Debtor credit limit', status: 'HOLD', detail: `No credit limit set for ${credit.debtorName}.` });
  else if (credit.approved === false) add({ id: 'credit-limit', label: 'Debtor credit limit', status: 'HOLD', detail: `The credit limit for ${credit.debtorName} is not approved.` });
  else {
    const after = creditAfter({ ...credit, thisInvoice: amount });
    add(after > credit.limit
      ? { id: 'credit-limit', label: 'Debtor credit limit', status: 'HOLD', detail: `Over the credit limit: ${money(after)} owed with this invoice against a ${money(credit.limit)} limit. Needs credit approval.` }
      : { id: 'credit-limit', label: 'Debtor credit limit', status: 'PASS', detail: `${money(after)} of ${money(credit.limit)} used with this invoice.` });
  }

  if (!cfg.slowDebtor.enabled) off('slow-debtor', 'Debtor pays on time');
  else if (!debtorRecords) add({ id: 'slow-debtor', label: 'Debtor pays on time', status: 'UNKNOWN', detail: "The debtor's invoices could not be read." });
  else {
    const cutoff = facts.now.getTime() - cfg.slowDebtor.pastDueDays * DAY;
    const open = debtorRecords.filter((r) => openArBalance(r) > 0);
    const total = open.reduce((s, r) => s + openArBalance(r), 0);
    const late = open.filter((r) => dateOf(r) < cutoff).reduce((s, r) => s + openArBalance(r), 0);
    const pct = total > 0 ? (late / total) * 100 : 0;
    add(pct > cfg.slowDebtor.maxPastDuePct
      ? { id: 'slow-debtor', label: 'Debtor pays on time', status: 'HOLD', detail: `${Math.round(pct)}% of what this debtor owes is over ${cfg.slowDebtor.pastDueDays} days old (limit ${cfg.slowDebtor.maxPastDuePct}%).` }
      : { id: 'slow-debtor', label: 'Debtor pays on time', status: 'PASS', detail: total > 0 ? `${Math.round(pct)}% of its open balance is over ${cfg.slowDebtor.pastDueDays} days old.` : 'Nothing open with this debtor.' });
  }

  const withDebtor = clientRecords?.filter((r) => r.companyDebtorId === facts.invoice.debtorId) ?? null;
  if (!cfg.newDebtor.enabled) off('new-debtor', 'Known debtor');
  else if (!withDebtor) add({ id: 'new-debtor', label: 'Known debtor', status: 'UNKNOWN', detail: "The client's invoices could not be read." });
  else add(withDebtor.length
    ? { id: 'new-debtor', label: 'Known debtor', status: 'PASS', detail: `${withDebtor.length} earlier invoice${withDebtor.length === 1 ? '' : 's'} with this debtor.` }
    : { id: 'new-debtor', label: 'Known debtor', status: 'HOLD', detail: "First invoice with this debtor: a person should look before it's funded." });

  if (!cfg.concentration.enabled) off('concentration', 'Debtor concentration');
  else if (!clientRecords || !withDebtor) add({ id: 'concentration', label: 'Debtor concentration', status: 'UNKNOWN', detail: "The client's invoices could not be read." });
  else {
    const all = clientRecords.reduce((s, r) => s + openArBalance(r), 0) + amount;
    const mine = withDebtor.reduce((s, r) => s + openArBalance(r), 0) + amount;
    const pct = all > 0 ? (mine / all) * 100 : 0;
    add(pct > cfg.concentration.maxPct
      ? { id: 'concentration', label: 'Debtor concentration', status: 'HOLD', detail: `This debtor would be ${Math.round(pct)}% of the client's open A/R (limit ${cfg.concentration.maxPct}%).` }
      : { id: 'concentration', label: 'Debtor concentration', status: 'PASS', detail: `${Math.round(pct)}% of the client's open A/R.` });
  }

  // Client
  if (!cfg.clientCreditLimit.enabled) off('client-credit', 'Client credit limit');
  else if (facts.clientCreditLimit === undefined || !clientRecords) add({ id: 'client-credit', label: 'Client credit limit', status: 'UNKNOWN', detail: "The client's credit limit or invoices could not be read." });
  else if (!facts.clientCreditLimit) add({ id: 'client-credit', label: 'Client credit limit', status: 'SKIP', detail: 'No client-level limit set in FactorCloud.' });
  else {
    const after = clientRecords.reduce((s, r) => s + openArBalance(r), 0) + amount;
    add(after > facts.clientCreditLimit
      ? { id: 'client-credit', label: 'Client credit limit', status: 'HOLD', detail: `Client would owe ${money(after)} against a ${money(facts.clientCreditLimit)} limit.` }
      : { id: 'client-credit', label: 'Client credit limit', status: 'PASS', detail: `${money(after)} of ${money(facts.clientCreditLimit)}.` });
  }

  if (!cfg.cashReserve.enabled) off('cash-reserve', 'Cash reserve');
  else if (facts.cashReserve === null) add({ id: 'cash-reserve', label: 'Cash reserve', status: 'UNKNOWN', detail: 'The cash reserve could not be read.' });
  else add(facts.cashReserve < 0
    ? { id: 'cash-reserve', label: 'Cash reserve', status: 'HOLD', detail: `Cash reserve is negative (${money(facts.cashReserve)}).` }
    : { id: 'cash-reserve', label: 'Cash reserve', status: 'PASS', detail: `Cash reserve ${money(facts.cashReserve)}.` });

  if (!cfg.volumeSpike.enabled) off('volume-spike', 'Volume spike');
  else if (!clientRecords) add({ id: 'volume-spike', label: 'Volume spike', status: 'UNKNOWN', detail: "The client's invoices could not be read." });
  else {
    const now = facts.now.getTime();
    const last30 = clientRecords.filter((r) => dateOf(r) >= now - 30 * DAY).length + 1;
    const prior = clientRecords.filter((r) => dateOf(r) < now - 30 * DAY && dateOf(r) >= now - 120 * DAY).length / 3;
    if (prior < 1) add({ id: 'volume-spike', label: 'Volume spike', status: 'SKIP', detail: 'Not enough history to compare.' });
    else add(last30 > cfg.volumeSpike.maxMultiple * prior
      ? { id: 'volume-spike', label: 'Volume spike', status: 'HOLD', detail: `${last30} invoices in the last 30 days against about ${Math.round(prior)} a month before (limit ${cfg.volumeSpike.maxMultiple}×).` }
      : { id: 'volume-spike', label: 'Volume spike', status: 'PASS', detail: `${last30} invoices in the last 30 days, about ${Math.round(prior)} a month before.` });
  }

  if (!cfg.newClient.enabled) off('new-client', 'Established client');
  else if (!clientRecords) add({ id: 'new-client', label: 'Established client', status: 'UNKNOWN', detail: "The client's invoices could not be read." });
  else {
    const first = Math.min(...clientRecords.map(dateOf).filter(Number.isFinite));
    const days = Number.isFinite(first) ? Math.floor((facts.now.getTime() - first) / DAY) : 0;
    const young = days < cfg.newClient.minDays || clientRecords.length < cfg.newClient.minInvoices;
    add(young
      ? { id: 'new-client', label: 'Established client', status: 'HOLD', detail: `New client: ${clientRecords.length} earlier invoice${clientRecords.length === 1 ? '' : 's'} over ${days} days (auto-funding starts at ${cfg.newClient.minInvoices} invoices and ${cfg.newClient.minDays} days).` }
      : { id: 'new-client', label: 'Established client', status: 'PASS', detail: `${clientRecords.length} earlier invoices over ${days} days.` });
  }

  // Caps on automatic funding
  const allowed = caps.autoFundClients === 'all' || caps.autoFundClients.includes(facts.invoice.clientId);
  add(allowed
    ? { id: 'cap-client', label: 'Client allowed to auto-fund', status: 'PASS', detail: caps.autoFundClients === 'all' ? 'All clients may be auto-funded.' : 'On the auto-fund list.', cap: true }
    : { id: 'cap-client', label: 'Client allowed to auto-fund', status: 'HOLD', detail: 'Not on the auto-fund list.', cap: true });
  add(amount > caps.perInvoice
    ? { id: 'cap-invoice', label: 'Per-invoice cap', status: 'HOLD', detail: `${money(amount)} is over the ${money(caps.perInvoice)} auto-funding cap.`, cap: true }
    : { id: 'cap-invoice', label: 'Per-invoice cap', status: 'PASS', detail: `${money(amount)} of ${money(caps.perInvoice)}.`, cap: true });
  if (!facts.fundedToday) add({ id: 'cap-daily', label: 'Daily caps', status: 'UNKNOWN', detail: "Today's auto-funding total could not be read.", cap: true });
  else {
    const client = facts.fundedToday.client + amount;
    const factor = facts.fundedToday.factor + amount;
    add(client > caps.perClientPerDay
      ? { id: 'cap-daily', label: 'Daily caps', status: 'HOLD', detail: `Would auto-fund ${money(client)} for this client today (cap ${money(caps.perClientPerDay)}).`, cap: true }
      : factor > caps.perFactorPerDay
        ? { id: 'cap-daily', label: 'Daily caps', status: 'HOLD', detail: `Would auto-fund ${money(factor)} across all clients today (cap ${money(caps.perFactorPerDay)}).`, cap: true }
        : { id: 'cap-daily', label: 'Daily caps', status: 'PASS', detail: `${money(client)} for this client, ${money(factor)} in all today.`, cap: true });
  }
  if (caps.businessHoursOnly) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: facts.timeZone ?? 'America/Chicago', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(facts.now);
    const day = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
    const open = !['Sat', 'Sun'].includes(day) && hour >= 8 && hour < 18;
    add(open
      ? { id: 'cap-hours', label: 'Business hours', status: 'PASS', detail: 'Within business hours.', cap: true }
      : { id: 'cap-hours', label: 'Business hours', status: 'HOLD', detail: 'Outside business hours (weekdays 8am–6pm).', cap: true });
  }

  const tripped = results.filter((r) => r.status === 'REVIEW' || r.status === 'HOLD' || r.status === 'UNKNOWN');
  const outcome: Outcome = tripped.some((r) => r.status === 'REVIEW') ? 'REVIEW' : tripped.length ? 'HOLD' : 'FUND';
  return { outcome, rules: results, reasons: tripped.map((r) => r.status === 'UNKNOWN' ? `${r.label}: ${r.detail}` : r.detail) };
}
