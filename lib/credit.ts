// Debtor credit: how much of the client's credit limit with a debtor is in use, and whether a new
// invoice fits. Pure, so the submit page can re-run it when the client edits the amount.

import type { CheckResult, ValidationReport } from './types';

export interface DebtorCredit {
  debtorId: string;
  debtorName: string;
  /** FactorCloud creditLimit for this client–debtor pair; null when none is set. */
  limit: number | null;
  approved: boolean | null;
  rating: number | null;
  noBuy: boolean;
  /** Unpaid balance already owed by this debtor on this client's invoices. */
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
  const label = 'Debtor credit limit';
  if (credit.lookupFailed) return { id, label, status: 'SKIP', message: 'The credit limit could not be checked right now.' };
  if (credit.noBuy) return { id, label, status: 'REVIEW', message: `FactorCloud marks ${credit.debtorName} as not approved for purchase.` };
  if (credit.approved === false) return { id, label, status: 'REVIEW', message: `The credit limit for ${credit.debtorName} is not approved yet.` };
  if (!credit.limit || credit.limit <= 0) return { id, label, status: 'SKIP', message: `No credit limit is set for ${credit.debtorName}.` };
  const after = creditAfter(credit);
  const comparisons = [{ label: 'After this invoice', document: money(after), other: `limit ${money(credit.limit)}` }];
  if (after > credit.limit) {
    return { id, label, status: 'REVIEW', message: `This invoice brings ${credit.debtorName} to ${money(after)}, ${money(after - credit.limit)} over the ${money(credit.limit)} credit limit.`, comparisons };
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
