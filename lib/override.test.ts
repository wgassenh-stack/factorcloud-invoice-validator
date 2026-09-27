import { describe, expect, it } from 'vitest';
import { clientExplanation, explanationProblem, flaggedChecks, hardBlocks, needsExplanation, withClientExplanation } from './override';
import type { ValidationReport } from './types';

const report = (status: ValidationReport['status'], ...checks: ValidationReport['checks']): ValidationReport => ({ status, checks });
const failDate = { id: 'invoice-age', label: 'Invoice date', status: 'FAIL' as const, message: 'Date does not match the BOL.' };

describe('submitting with an explanation', () => {
  it('asks for a reason on anything that is not a clean pass', () => {
    expect(needsExplanation(report('PASS'))).toBe(false);
    expect(needsExplanation(report('REVIEW'))).toBe(true);
    expect(needsExplanation(report('FAIL', failDate))).toBe(true);
    expect(explanationProblem('ok')).toMatch(/at least 10/);
    expect(explanationProblem('   date is one day off  ')).toBeNull();
    expect(explanationProblem('x'.repeat(501))).toMatch(/under 500/);
  });

  it('sends a failed invoice to review with the note first and the failures kept', () => {
    const out = withClientExplanation(report('FAIL', failDate), ' Date is one day off, still valid. ');
    expect(out.status).toBe('REVIEW');
    expect(out.checks[0]).toMatchObject({ id: 'client-explanation', message: 'Date is one day off, still valid.' });
    expect(out.checks[1]).toEqual(failDate);
    expect(clientExplanation(out.checks)).toBe('Date is one day off, still valid.');
    expect(flaggedChecks(out.checks)).toEqual([failDate]);
    // Explaining twice replaces the note rather than stacking it.
    expect(withClientExplanation(out, 'Second explanation here').checks.filter((c) => c.id === 'client-explanation')).toHaveLength(1);
  });

  it('never lets a No Buy or missing debtor through', () => {
    const noBuy = { id: 'debtor-found', label: 'Debtor found', status: 'FAIL' as const, message: 'Titan is flagged No Buy.' };
    expect(hardBlocks(report('FAIL', noBuy, failDate))).toEqual([noBuy]);
    expect(hardBlocks(report('FAIL', failDate))).toEqual([]);
  });
});
