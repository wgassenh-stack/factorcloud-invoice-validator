import { describe, expect, it } from 'vitest';
import { buildDebtorSummaries } from './debtors';
import type { RiskInvoiceRecord } from './risk';

const TODAY = '2026-09-26';
const inv = (id: string, over: Partial<RiskInvoiceRecord>): RiskInvoiceRecord => ({ id, invoiceNumber: id, companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 1000, invoiceDate: '2026-09-20', status: 'FUNDED', fundedDate: '2026-09-21', invoiceBalance: 1000, ...over });

describe('debtor summaries', () => {
  const records = [
    inv('a', {}),
    inv('b', { companyClientId: 'c2', invoiceDate: '2026-06-01', fundedDate: '2026-06-02', invoiceBalance: 500, disputed: true }),
    inv('c', { invoiceDate: '2026-07-01', paidDate: '2026-08-10', status: 'PAID', invoiceBalance: 0 }),
    inv('d', { companyDebtorId: 'd2', invoiceAmount: 300, invoiceBalance: 300 }),
    inv('e', { companyDebtorId: 'd2', status: 'REJECTED' }),
    inv('f', { companyDebtorId: 'd3', status: 'PENDING', fundedDate: null, verificationStatus: 'NOT_VERIFIED' }),
  ];
  const [d1, d2, d3] = buildDebtorSummaries(records, TODAY, { debtors: { d1: 'Acme' }, clients: { c1: 'One', c2: 'Two' } });

  it('sums open funded balances into age buckets and ranks by exposure', () => {
    expect(d1).toMatchObject({ name: 'Acme', openBalance: 1500, openCount: 2, clientCount: 2, topClient: 'One', buckets: [1000, 0, 0, 500], oldestOpenDays: 117, disputedCount: 1 });
    expect(d1.share).toBeCloseTo(1500 / 1800);
    expect(d2.openBalance).toBe(300);
  });

  it('measures days to pay on recent payments, ignoring rejected and unfunded invoices', () => {
    expect(d1.daysToPay).toBe(40);
    expect(d1.paidCount).toBe(1);
    expect(d2.openCount).toBe(1);
    expect(d3).toMatchObject({ openBalance: 0, recentVolume: 1000 });
  });
});
