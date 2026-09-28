// Submitting an invoice that did not pass every check. The client may send it anyway with a written
// explanation; it then goes to the factor's review queue with that note. Mismatches (address, phone,
// amount, load number, invoice age, unclear reading) can be explained. Some things are the factor's
// call, never the client's: no invoice document at all, a missing or No Buy debtor, and an invoice
// that already exists in FactorCloud (the create step refuses exact duplicates on its own).

import type { CheckResult, ValidationReport } from './types';

export const EXPLANATION_CHECK_ID = 'client-explanation';
export const MIN_EXPLANATION_LENGTH = 10;
export const MAX_EXPLANATION_LENGTH = 500;

/** Failed checks only the factor can get past, never with a client's note. */
const FACTOR_ONLY = new Set(['debtor-found', 'invoice-document', 'documents']);

/** Failed checks that no explanation can get past. */
export function hardBlocks(validation: ValidationReport): CheckResult[] {
  return validation.checks.filter((check) => check.status === 'FAIL' && FACTOR_ONLY.has(check.id));
}

/** What to tell the client about a check they can't override. */
export function blockAdvice(blocked: CheckResult[]): string {
  if (blocked.some((c) => c.id === 'invoice-document' || c.id === 'documents')) return 'Add the invoice document itself, or contact your factor.';
  return 'Contact your factor about this debtor.';
}

/** Anything short of a clean pass needs the client to say why they are submitting anyway. */
export function needsExplanation(validation: ValidationReport): boolean {
  return validation.status !== 'PASS';
}

export function explanationProblem(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim();
  if (trimmed.length < MIN_EXPLANATION_LENGTH) return `Explain why you are submitting anyway (at least ${MIN_EXPLANATION_LENGTH} characters).`;
  if (trimmed.length > MAX_EXPLANATION_LENGTH) return `Keep the explanation under ${MAX_EXPLANATION_LENGTH} characters.`;
  return null;
}

/**
 * Records the client's explanation as the first check and sends the invoice to review. The checks
 * that failed stay marked FAIL so the reviewer sees exactly what was wrong.
 */
export function withClientExplanation(validation: ValidationReport, text: string): ValidationReport {
  const note: CheckResult = { id: EXPLANATION_CHECK_ID, label: "Client's note", status: 'REVIEW', message: text.trim() };
  return { status: 'REVIEW', checks: [note, ...validation.checks.filter((check) => check.id !== EXPLANATION_CHECK_ID)] };
}

export function clientExplanation(checks: CheckResult[] | undefined): string | null {
  return checks?.find((check) => check.id === EXPLANATION_CHECK_ID)?.message ?? null;
}

/** The checks a reviewer should look at: warnings and failures, without the client's own note. */
export function flaggedChecks(checks: CheckResult[] | undefined): CheckResult[] {
  return (checks ?? []).filter((check) => check.id !== EXPLANATION_CHECK_ID && (check.status === 'REVIEW' || check.status === 'FAIL'));
}

/**
 * The final result for an invoice the client sent anyway. Hard blocks were refused before this, so
 * any remaining warning or failure has the client's explanation and goes to the factor's review
 * queue. Later steps (the credit check, an incomplete duplicate check) recompute the status from
 * the checks, which would turn an explained failure back into FAIL and skip the queue.
 */
export function forFactorReview(validation: ValidationReport): ValidationReport {
  return validation.status === 'FAIL' ? { ...validation, status: 'REVIEW' } : validation;
}
