// Portfolio analytics for the factor command center and the client dashboard. Pure functions over
// the invoice records FactorCloud returns, so they work the same on live and demo data. Fields that
// FactorCloud leaves empty simply drop out of the sums.

import type { RiskInvoiceRecord } from './risk';

const DAY_MS = 86_400_000;

export const AGING_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', '90+ days'] as const;

export interface AgingRow {
  key: string;
  label: string;
  buckets: number[];
  total: number;
}

export interface AgingSummary {
  buckets: readonly string[];
  rows: AgingRow[];
  totals: number[];
  openBalance: number;
  openCount: number;
}

export interface ExposureItem {
  id: string;
  name: string;
  value: number;
  share: number;
  invoiceCount: number;
  level: 'NORMAL' | 'REVIEW' | 'HIGH';
}

export interface MonthlyCash {
  key: string;
  label: string;
  advanced: number;
  collected: number;
  fees: number;
}

export interface DsoPoint {
  key: string;
  label: string;
  days: number | null;
  paidCount: number;
}

export interface DayVolume {
  date: string;
  count: number;
  amount: number;
}

export type LifecycleStage = 'SUBMITTED' | 'VERIFIED' | 'FUNDED' | 'PAID';
export const LIFECYCLE_STAGES: { key: LifecycleStage; label: string }[] = [
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: 'VERIFIED', label: 'Verified' },
  { key: 'FUNDED', label: 'Funded' },
  { key: 'PAID', label: 'Paid' },
];

export interface CashSummary {
  /** Sent in but not funded yet: the factor still has to approve and pay these. */
  waitingOnFactor: { count: number; amount: number; oldestDays: number | null };
  /**
   * Funded invoices the debtors have not paid yet, split so the parts add up to the total:
   * advanced to the client + the factor's fee + reserve the client gets back once the debtor pays.
   * `notBrokenOut` is invoice value FactorCloud sent no advance amount for.
   */
  withDebtors: { count: number; amount: number; advanced: number; fees: number; reserveBack: number; notBrokenOut: number; stillOwed: number; balanceAssumed: number };
  /** Money that reached the client in the last 30 days: advances plus reserve released on paid invoices. */
  last30: { advanced: number; reserveReleased: number; fees: number };
  /** Balance still owed on funded invoices more than 60 days after the invoice date (matches the aging chart). */
  over60: { count: number; amount: number };
  avgDaysToPay: number | null;
  pipeline: { stage: LifecycleStage; label: string; count: number; amount: number }[];
}

export interface PortfolioKpis {
  openBalance: number;
  openCount: number;
  fundedLast30: number;
  collectedLast30: number;
  feesLast30: number;
  dsoLast90: number | null;
  dsoPrior90: number | null;
}

// --- helpers -------------------------------------------------------------------------------------

function dayMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
}

function daysBetween(from: string | null | undefined, to: number): number {
  const start = dayMs(from);
  return Number.isFinite(start) ? Math.floor((to - start) / DAY_MS) : NaN;
}

function monthKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

function monthLabel(key: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${key}-01T00:00:00Z`));
}

function lastMonths(today: string, count: number): string[] {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (count - 1 - i), 1));
    return m.toISOString().slice(0, 7);
  });
}

// FactorCloud's documented values: invoice status PENDING, HELD, REJECTED, CANCELED, NEED_VERIFIED,
// APPROVED, PURCHASED, FUNDED, PAID; verificationStatus DENIED, NOT_VERIFIED, PENDING, VERIFIED;
// paymentStatus is free text such as "Open". Match whole values, never substrings ("NOT_VERIFIED"
// contains "VERIFIED", "Unpaid" contains "PAID").
function token(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/** Rejected or canceled: no longer part of the pipeline or the receivables. */
export function isClosedOut(record: RiskInvoiceRecord): boolean {
  return ['REJECTED', 'CANCELED', 'CANCELLED', 'VOID'].includes(token(record.status));
}

/** Whether an invoice is paid off, by any of the signals FactorCloud may send. */
export function isPaid(record: RiskInvoiceRecord): boolean {
  if (record.paidDate) return true;
  if (['PAID', 'CLOSED', 'PAID_IN_FULL'].includes(token(record.paymentStatus))) return true;
  return token(record.status) === 'PAID';
}

/**
 * Money still owed on an invoice that has been bought (funded) and not yet paid off. Uses
 * FactorCloud's invoice balance; when FactorCloud sends none, the full invoice amount is assumed
 * (see `balanceReported`, so screens can say so instead of presenting it as fact).
 */
export function openBalance(record: RiskInvoiceRecord): number {
  if (isPaid(record) || isClosedOut(record)) return 0;
  return Math.max(0, record.invoiceBalance ?? record.invoiceAmount ?? 0);
}

/**
 * What an invoice adds to FactorCloud's OpenAR, the figure its credit limits are checked against:
 * the unpaid balance of invoices that have been approved for funding or funded. Pending invoices
 * don't count until they are approved (FactorCloud said 36,000 OpenAR where counting pending ones
 * too gave $54,956).
 */
export function openArBalance(record: RiskInvoiceRecord): number {
  const status = token(record.status);
  const counted = Boolean(record.fundedDate) || ['APPROVED', 'PURCHASED', 'FUNDED'].includes(status);
  return counted ? openBalance(record) : 0;
}

/** Whether FactorCloud sent a balance for this invoice (rather than it being assumed). */
export function balanceReported(record: RiskInvoiceRecord): boolean {
  return record.invoiceBalance !== null && record.invoiceBalance !== undefined;
}

/**
 * The reserve on an invoice: what the client gets back once the debtor pays. FactorCloud splits an
 * invoice into advance + escrow reserve + purchase fee, which add up to the invoice amount (checked
 * on a real invoice: $8,190 + $1,462.50 + $97.50 = $9,750), so the fee is not taken out of the
 * escrow reserve. Without an escrow figure, the reserve is what's left after the advance and fee.
 */
export function reserveOn(record: RiskInvoiceRecord): number {
  if (record.escrowReserveAmount !== null && record.escrowReserveAmount !== undefined) return Math.max(0, record.escrowReserveAmount);
  if (record.advanceAmount === null || record.advanceAmount === undefined) return 0;
  return Math.max(0, (record.invoiceAmount ?? 0) - record.advanceAmount - (record.purchaseFeeAmount ?? 0));
}

export function lifecycleStage(record: RiskInvoiceRecord): LifecycleStage {
  if (isPaid(record)) return 'PAID';
  const status = token(record.status);
  if (record.fundedDate || status === 'FUNDED' || status === 'PURCHASED') return 'FUNDED';
  if (token(record.verificationStatus) === 'VERIFIED' || status === 'APPROVED') return 'VERIFIED';
  return 'SUBMITTED';
}

function isFunded(record: RiskInvoiceRecord): boolean {
  const stage = lifecycleStage(record);
  return stage === 'FUNDED' || (stage === 'PAID' && Boolean(record.fundedDate || record.advanceAmount));
}

// --- builders ------------------------------------------------------------------------------------

export function buildAging(records: RiskInvoiceRecord[], groupNames: Record<string, string>, today: string, groupBy: 'client' | 'debtor' = 'client', top = 6): AgingSummary {
  const todayMs = dayMs(today);
  const groups = new Map<string, AgingRow>();
  const totals = [0, 0, 0, 0];
  let openCount = 0;

  for (const record of records) {
    if (!isFunded(record)) continue;
    const balance = openBalance(record);
    if (balance <= 0) continue;
    const age = daysBetween(record.invoiceDate, todayMs);
    if (!Number.isFinite(age)) continue;
    const bucket = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
    const key = (groupBy === 'client' ? record.companyClientId : record.companyDebtorId) || 'unknown';
    const row = groups.get(key) ?? { key, label: groupNames[key] || key, buckets: [0, 0, 0, 0], total: 0 };
    row.buckets[bucket] += balance;
    row.total += balance;
    totals[bucket] += balance;
    openCount += 1;
    groups.set(key, row);
  }

  const sorted = [...groups.values()].sort((a, b) => b.total - a.total);
  const rows = sorted.slice(0, top);
  const rest = sorted.slice(top);
  if (rest.length) {
    rows.push(rest.reduce<AgingRow>((other, row) => {
      row.buckets.forEach((value, i) => { other.buckets[i] += value; });
      other.total += row.total;
      return other;
    }, { key: 'other', label: `Other (${rest.length})`, buckets: [0, 0, 0, 0], total: 0 }));
  }
  return { buckets: AGING_BUCKETS, rows, totals, openBalance: totals.reduce((a, b) => a + b, 0), openCount };
}

/** Open balance on funded invoices by client (or debtor), for the concentration treemap. */
export function buildExposure(records: RiskInvoiceRecord[], groupNames: Record<string, string>, groupBy: 'client' | 'debtor' = 'client', thresholds = { review: 0.15, high: 0.25 }): ExposureItem[] {
  const byGroup = new Map<string, { value: number; count: number }>();
  for (const record of records) {
    const value = openBalance(record);
    if (value <= 0 || !isFunded(record)) continue;
    const key = (groupBy === 'client' ? record.companyClientId : record.companyDebtorId) || 'unknown';
    const current = byGroup.get(key) ?? { value: 0, count: 0 };
    current.value += value;
    current.count += 1;
    byGroup.set(key, current);
  }
  const total = [...byGroup.values()].reduce((sum, item) => sum + item.value, 0);
  return [...byGroup.entries()]
    .map(([id, item]) => {
      const share = total > 0 ? item.value / total : 0;
      return {
        id,
        name: groupNames[id] || id,
        value: item.value,
        share,
        invoiceCount: item.count,
        level: share >= thresholds.high ? 'HIGH' as const : share >= thresholds.review ? 'REVIEW' as const : 'NORMAL' as const,
      };
    })
    .sort((a, b) => b.value - a.value);
}

export function buildMonthlyCash(records: RiskInvoiceRecord[], today: string, months = 12): MonthlyCash[] {
  const keys = lastMonths(today, months);
  const rows = new Map(keys.map((key) => [key, { key, label: monthLabel(key), advanced: 0, collected: 0, fees: 0 }]));
  for (const record of records) {
    const funded = dayMs(record.fundedDate);
    if (Number.isFinite(funded)) {
      const row = rows.get(monthKey(funded));
      if (row) row.advanced += record.advanceAmount ?? 0;
    }
    const paid = dayMs(record.paidDate);
    if (Number.isFinite(paid)) {
      const row = rows.get(monthKey(paid));
      if (row) {
        row.collected += record.invoiceAmount ?? 0;
        row.fees += record.purchaseFeeAmount ?? 0;
      }
    }
  }
  return keys.map((key) => rows.get(key)!);
}

/** Amount-weighted days from invoice date to payment, for invoices paid in each month. */
export function buildDsoTrend(records: RiskInvoiceRecord[], today: string, months = 12): DsoPoint[] {
  const keys = lastMonths(today, months);
  const acc = new Map(keys.map((key) => [key, { weighted: 0, weight: 0, count: 0 }]));
  for (const record of records) {
    const paid = dayMs(record.paidDate);
    const issued = dayMs(record.invoiceDate);
    if (!Number.isFinite(paid) || !Number.isFinite(issued)) continue;
    const bucket = acc.get(monthKey(paid));
    if (!bucket) continue;
    const weight = Math.max(record.invoiceAmount ?? 0, 1);
    bucket.weighted += ((paid - issued) / DAY_MS) * weight;
    bucket.weight += weight;
    bucket.count += 1;
  }
  return keys.map((key) => {
    const bucket = acc.get(key)!;
    return { key, label: monthLabel(key), days: bucket.weight > 0 ? bucket.weighted / bucket.weight : null, paidCount: bucket.count };
  });
}

/** Invoices submitted per day, for a calendar heatmap ending today. */
export function buildDailyVolume(records: RiskInvoiceRecord[], today: string, weeks = 26): DayVolume[] {
  const todayMs = dayMs(today);
  const weekday = (new Date(todayMs).getUTCDay() + 6) % 7; // Monday = 0
  const start = todayMs - (weeks - 1) * 7 * DAY_MS - weekday * DAY_MS;
  const days = new Map<string, DayVolume>();
  for (let ms = start; ms <= todayMs; ms += DAY_MS) {
    const date = new Date(ms).toISOString().slice(0, 10);
    days.set(date, { date, count: 0, amount: 0 });
  }
  for (const record of records) {
    const date = (record.createdOn || record.invoiceDate)?.slice(0, 10);
    const day = date ? days.get(date) : undefined;
    if (!day) continue;
    day.count += 1;
    day.amount += record.invoiceAmount ?? 0;
  }
  return [...days.values()];
}

function weightedDaysToPay(records: RiskInvoiceRecord[], fromMs: number, toMs: number): number | null {
  let weighted = 0;
  let weight = 0;
  for (const record of records) {
    const paid = dayMs(record.paidDate);
    const issued = dayMs(record.invoiceDate);
    if (!Number.isFinite(paid) || !Number.isFinite(issued) || paid < fromMs || paid > toMs) continue;
    const w = Math.max(record.invoiceAmount ?? 0, 1);
    weighted += ((paid - issued) / DAY_MS) * w;
    weight += w;
  }
  return weight > 0 ? weighted / weight : null;
}

export function buildKpis(records: RiskInvoiceRecord[], today: string): PortfolioKpis {
  const todayMs = dayMs(today);
  const since30 = todayMs - 29 * DAY_MS;
  let openBalanceTotal = 0;
  let openCount = 0;
  let fundedLast30 = 0;
  let collectedLast30 = 0;
  let feesLast30 = 0;
  for (const record of records) {
    const balance = isFunded(record) ? openBalance(record) : 0;
    if (balance > 0) { openBalanceTotal += balance; openCount += 1; }
    const funded = dayMs(record.fundedDate);
    if (funded >= since30 && funded <= todayMs) fundedLast30 += record.advanceAmount ?? 0;
    const paid = dayMs(record.paidDate);
    if (paid >= since30 && paid <= todayMs) {
      collectedLast30 += record.invoiceAmount ?? 0;
      feesLast30 += record.purchaseFeeAmount ?? 0;
    }
  }
  return {
    openBalance: openBalanceTotal,
    openCount,
    fundedLast30,
    collectedLast30,
    feesLast30,
    dsoLast90: weightedDaysToPay(records, todayMs - 89 * DAY_MS, todayMs),
    dsoPrior90: weightedDaysToPay(records, todayMs - 179 * DAY_MS, todayMs - 90 * DAY_MS),
  };
}

/** A client's money picture: what the factor still owes them a decision on, where the money on funded invoices went, and what arrived lately. */
export function buildCashSummary(records: RiskInvoiceRecord[], today: string): CashSummary {
  const todayMs = dayMs(today);
  const since30 = todayMs - 29 * DAY_MS;
  const pipeline = LIFECYCLE_STAGES.map((stage) => ({ stage: stage.key, label: stage.label, count: 0, amount: 0 }));
  const waitingOnFactor = { count: 0, amount: 0, oldestDays: null as number | null };
  const withDebtors = { count: 0, amount: 0, advanced: 0, fees: 0, reserveBack: 0, notBrokenOut: 0, stillOwed: 0, balanceAssumed: 0 };
  const last30 = { advanced: 0, reserveReleased: 0, fees: 0 };
  const over60 = { count: 0, amount: 0 };

  for (const record of records) {
    if (isClosedOut(record)) continue;
    const stage = lifecycleStage(record);
    const amount = record.invoiceAmount ?? 0;
    const bucket = pipeline.find((p) => p.stage === stage)!;
    // Paid invoices only count toward the pipeline for the last 30 days, so the bar stays readable.
    const paidMs = dayMs(record.paidDate);
    if (stage !== 'PAID' || paidMs >= since30) {
      bucket.count += 1;
      bucket.amount += amount;
    }
    const funded = dayMs(record.fundedDate);
    if (funded >= since30 && funded <= todayMs) last30.advanced += record.advanceAmount ?? 0;
    if (paidMs >= since30 && paidMs <= todayMs) {
      last30.fees += record.purchaseFeeAmount ?? 0;
      last30.reserveReleased += reserveOn(record);
    }

    if (stage === 'SUBMITTED' || stage === 'VERIFIED') {
      waitingOnFactor.count += 1;
      waitingOnFactor.amount += amount;
      const sent = dayMs(record.createdOn ?? record.invoiceDate);
      if (Number.isFinite(sent)) {
        const days = Math.max(0, Math.floor((todayMs - sent) / DAY_MS));
        waitingOnFactor.oldestDays = Math.max(waitingOnFactor.oldestDays ?? 0, days);
      }
    } else if (stage === 'FUNDED') {
      withDebtors.count += 1;
      withDebtors.amount += amount;
      const owed = openBalance(record);
      withDebtors.stillOwed += owed;
      if (!balanceReported(record)) withDebtors.balanceAssumed += 1;
      if (record.advanceAmount == null) {
        withDebtors.notBrokenOut += amount;
      } else {
        // The reserve back is whatever is left, so the three parts always add up to the invoice.
        const advanced = Math.min(amount, record.advanceAmount);
        const fee = Math.min(amount - advanced, Math.max(0, record.purchaseFeeAmount ?? 0));
        withDebtors.advanced += advanced;
        withDebtors.fees += fee;
        withDebtors.reserveBack += amount - advanced - fee;
      }
      const issued = dayMs(record.invoiceDate);
      if (owed > 0 && Number.isFinite(issued) && todayMs - issued > 60 * DAY_MS) {
        over60.count += 1;
        over60.amount += owed;
      }
    }
  }
  return { waitingOnFactor, withDebtors, last30, over60, avgDaysToPay: weightedDaysToPay(records, todayMs - 179 * DAY_MS, todayMs), pipeline };
}
