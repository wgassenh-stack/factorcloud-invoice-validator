// Submitting an invoice that did not pass every check. The client may send it anyway with a written
// explanation; it then goes to the factor's review queue with that note. A few checks can never be
// overridden because the factor has already said no (a No Buy debtor) or there is no debtor at all.

import type { CheckResult, ValidationReport } from './types';

export const EXPLANATION_CHECK_ID = 'client-explanation';
export const MIN_EXPLANATION_LENGTH = 10;
export const MAX_EXPLANATION_LENGTH = 500;

/** Failed checks that no explanation can get past. */
export function hardBlocks(validation: ValidationReport): CheckResult[] {
  return validation.checks.filter((check) => check.status === 'FAIL' && check.id === 'debtor-found');
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
