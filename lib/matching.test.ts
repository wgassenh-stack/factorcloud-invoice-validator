import { describe, expect, it } from 'vitest';
import type { CompanyRecord } from './types';
import { scoreDebtor } from './matching';

const acme: CompanyRecord = {
  id: 'acme',
  companyName: 'Acme Manufacturing LLC',
  phone: '3343770535',
  ein: '987654321',
};

describe('debtor matching', () => {
  it('prefers an exact EIN match', () => {
    expect(scoreDebtor({ name: 'Something Else', ein: '98-7654321', phone: null }, acme)).toEqual({ method: 'EIN', score: 1 });
  });

  it('matches normalized exact company names', () => {
    expect(scoreDebtor({ name: 'ACME Mfg., Inc.', ein: null, phone: null }, acme)?.method).toBe('Exact name');
  });

  it('can use phone plus a similar name', () => {
    const result = scoreDebtor({ name: 'Acme Manufacturing Services', ein: null, phone: '(334) 377-0535' }, acme);
    expect(result?.method).toBe('Phone + similar name');
  });

  it('does not match an unrelated company', () => {
    expect(scoreDebtor({ name: 'Totally Different Logistics', ein: null, phone: '9999999999' }, acme)).toBeNull();
  });
});
