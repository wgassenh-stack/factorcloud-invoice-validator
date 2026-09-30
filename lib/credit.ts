// Debtor credit: how much of the client's credit limit with a debtor is in use, and whether a new
// invoice fits. Factor-side only: the person submitting never sees it. When an invoice would go over
// the limit, the approver gets a warning on the review card. Pure, so it can be tested.

import type { CheckResult, ValidationReport } from './types';

export interface DebtorCredit {
  debtorId: string;
  debtorName: string;
  /** FactorCloud creditLimit for this client–debtor pair; null when none is set. */
  limit: number | null;
  approved: boolean | null;
  rating: number | null;
  noBuy: boolean;
  /** This debtor's share of the client's OpenAR: approved or funded invoices not yet paid. */
  openBalance: number;
  openCount: number;
  thisInvoice: number;
  lookupFailed?: boolean;
}

export function creditAfter(credit: DebtorCredit): number {
  return credit.openBalance + credit.thisInvoice;
}

export function withInvoiceAmount(credit: DebtorCredit, amount: number | null | undefined): DebtorCredit {
  return { ...credit, thisInvoice: amount && amount > 0 ? amount : 0 };
}

const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

export function creditCheck(credit: DebtorCredit | null | undefined): CheckResult | null {
  if (!credit) return null;
  const id = 'debtor-credit';
  const label = 'Credit limit (factor only)';
  if (credit.lookupFailed) return { id, label, status: 'SKIP', message: 'The credit limit could not be checked right now.' };
  if (credit.noBuy) return { id, label, status: 'REVIEW', message: `Warning: FactorCloud marks ${credit.debtorName} as not approved for purchase.` };
  if (credit.approved === false) return { id, label, status: 'REVIEW', message: `Warning: the credit limit for ${credit.debtorName} is not approved yet.` };
  if (!credit.limit || credit.limit <= 0) return { id, label, status: 'SKIP', message: `No credit limit is set for ${credit.debtorName}.` };
  const after = creditAfter(credit);
  const comparisons = [{ label: 'After this invoice', document: money(after), other: `limit ${money(credit.limit)}` }];
  if (after > credit.limit) {
    return { id, label, status: 'REVIEW', message: `Warning: this may put the client over the credit limit. With this invoice, ${credit.debtorName} would owe ${money(after)} (${money(credit.openBalance)} already open + ${money(credit.thisInvoice)} this invoice), ${money(after - credit.limit)} over the ${money(credit.limit)} limit.`, comparisons };
  }
  return { id, label, status: 'PASS', message: `${money(after)} of the ${money(credit.limit)} limit in use after this invoice (${Math.round((after / credit.limit) * 100)}%).`, comparisons };
}

/** Adds the credit check to a validation report; a REVIEW check makes the report REVIEW. */
export function applyCreditCheck(report: ValidationReport, credit: DebtorCredit | null | undefined): ValidationReport {
  const check = creditCheck(credit);
  if (!check) return report;
  const checks = [...report.checks.filter((c) => c.id !== check.id), check];
  // Recomputed from the checks, so re-running with a smaller amount can clear an earlier REVIEW.
  const status = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'REVIEW') ? 'REVIEW' : 'PASS';
  return { status, checks };
}

export const CREDIT_CHECK_ID = 'debtor-credit';

/**
 * What the client may see of a report: the credit check removed and the status worked out without
 * it, so a credit warning never tells the submitter anything about the factor's limits.
 */
export function withoutCreditCheck(report: ValidationReport): ValidationReport {
  const checks = report.checks.filter((c) => c.id !== CREDIT_CHECK_ID);
  const status = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'REVIEW') ? 'REVIEW' : 'PASS';
  return { status, checks };
}
