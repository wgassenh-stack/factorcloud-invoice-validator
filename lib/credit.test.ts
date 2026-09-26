import { describe, expect, it } from 'vitest';
import { applyCreditCheck, creditCheck, withInvoiceAmount, type DebtorCredit } from './credit';

const base: DebtorCredit = { debtorId: 'd1', debtorName: 'Acme', limit: 50_000, approved: true, rating: 80, noBuy: false, openBalance: 40_000, openCount: 9, thisInvoice: 5_000 };

describe('debtor credit check', () => {
  it('passes within the limit and shows the usage', () => {
    expect(creditCheck(base)).toMatchObject({ status: 'PASS', message: '$45,000 of the $50,000 limit in use after this invoice (90%).' });
  });

  it('flags an invoice that goes over the limit for review', () => {
    const check = creditCheck(withInvoiceAmount(base, 12_000))!;
    expect(check.status).toBe('REVIEW');
    expect(check.message).toContain('$2,000 over');
  });

  it('flags no-buy debtors and unapproved limits, and skips when unknown', () => {
    expect(creditCheck({ ...base, noBuy: true })!.status).toBe('REVIEW');
    expect(creditCheck({ ...base, approved: false })!.status).toBe('REVIEW');
    expect(creditCheck({ ...base, limit: null })!.status).toBe('SKIP');
    expect(creditCheck({ ...base, lookupFailed: true })!.status).toBe('SKIP');
    expect(creditCheck(null)).toBeNull();
  });

  it('turns a passing report into review, never softens a failure, and replaces an older credit check', () => {
    const pass = { status: 'PASS' as const, checks: [] };
    expect(applyCreditCheck(pass, withInvoiceAmount(base, 20_000)).status).toBe('REVIEW');
    expect(applyCreditCheck({ status: 'FAIL', checks: [{ id: 'x', label: 'x', status: 'FAIL', message: '' }] }, base).status).toBe('FAIL');
    const twice = applyCreditCheck(applyCreditCheck(pass, withInvoiceAmount(base, 20_000)), base);
    expect(twice.checks.filter((c) => c.id === 'debtor-credit')).toHaveLength(1);
    expect(twice.status).toBe('PASS');
  });
});
