import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { sameBatch } from './funding-engine';

describe('funding only the batch that was reviewed', () => {
  const reviewed = [{ invoiceId: 'a', amount: 400 }, { invoiceId: 'b', amount: 450 }];
  it('matches the same invoices and amounts, in any order', () => {
    expect(sameBatch([{ invoiceId: 'b', amount: 450 }, { invoiceId: 'a', amount: 400 }], reviewed)).toBe(true);
  });
  it('refuses when an invoice joined, left, or changed amount', () => {
    expect(sameBatch([...reviewed, { invoiceId: 'c', amount: 10 }], reviewed)).toBe(false);
    expect(sameBatch([reviewed[0]], reviewed)).toBe(false);
    expect(sameBatch([{ invoiceId: 'a', amount: 400 }, { invoiceId: 'b', amount: 460 }], reviewed)).toBe(false);
    expect(sameBatch([{ invoiceId: 'a', amount: 400 }, { invoiceId: 'z', amount: 450 }], reviewed)).toBe(false);
  });
  it('an amount FactorCloud did not report never counts as a match: funding needs every amount known', () => {
    expect(sameBatch([{ invoiceId: 'a', amount: 400 }, { invoiceId: 'b', amount: null }], reviewed)).toBe(false);
  });
});
