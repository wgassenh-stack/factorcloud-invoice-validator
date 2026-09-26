import { describe, expect, it } from 'vitest';
import { fairCoverage, fieldCoverage, valueCounts } from './field-coverage';
import type { RiskInvoiceRecord } from './risk';

const inv = (over: Partial<RiskInvoiceRecord>): RiskInvoiceRecord => ({ id: 'x', invoiceNumber: '1', companyClientId: 'c', companyDebtorId: 'd', invoiceAmount: 100, invoiceDate: '2026-09-01', status: 'PENDING', ...over });

describe('field coverage', () => {
  const records = [
    inv({ status: 'PENDING', verificationStatus: 'NOT_VERIFIED' }),
    inv({ status: 'FUNDED', fundedDate: '2026-09-02', invoiceBalance: 100, paymentStatus: 'Open' }),
    inv({ status: 'PAID', fundedDate: '2026-09-02', paidDate: '2026-09-20', invoiceBalance: 0, paymentStatus: 'Paid' }),
  ];

  it('counts filled-in fields across all invoices, treating 0 as present', () => {
    const balance = fieldCoverage(records).find((r) => r.field === 'invoiceBalance')!;
    expect(balance).toMatchObject({ present: 2, total: 3 });
  });

  it('measures funding fields against funded invoices and paid date against paid ones', () => {
    const fair = fairCoverage(records);
    expect(fair.find((r) => r.field === 'fundedDate')).toMatchObject({ present: 2, total: 2, share: 1 });
    expect(fair.find((r) => r.field === 'paidDate')).toMatchObject({ present: 1, total: 1, share: 1 });
    expect(fair.find((r) => r.field === 'advanceAmount')).toMatchObject({ present: 0, total: 2 });
  });

  it('lists the status values actually seen, most common first', () => {
    const [status, verification] = valueCounts(records);
    expect(status.values.map((v) => v.value)).toEqual(['PENDING', 'FUNDED', 'PAID']);
    expect(verification.values).toEqual([{ value: '(empty)', count: 2 }, { value: 'NOT_VERIFIED', count: 1 }]);
  });
});
