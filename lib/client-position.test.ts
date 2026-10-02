import { describe, expect, it } from 'vitest';
import { clientPosition } from './client-position';
import type { RiskInvoiceRecord } from './risk';

const inv = (o: Partial<RiskInvoiceRecord>): RiskInvoiceRecord => ({ id: String(Math.random()), invoiceNumber: 'X', companyClientId: 'c', companyDebtorId: 'd', invoiceAmount: 1000, invoiceDate: '2026-09-20', status: 'PENDING', ...o } as RiskInvoiceRecord);

describe('where a client stands', () => {
  it('funded money still out counts funded invoices only; approved ones are not funded yet but use credit; paid and rejected drop out', () => {
    const p = clientPosition([
      inv({ status: 'FUNDED', fundedDate: '2026-09-21', invoiceBalance: 1000, advanceAmount: 900, escrowReserveAmount: 80, invoiceDate: '2026-09-20' }),
      inv({ status: 'FUNDED', fundedDate: '2026-06-01', invoiceBalance: 500, invoiceAmount: 500, advanceAmount: 450, escrowReserveAmount: 40, invoiceDate: '2026-06-01' }),
      inv({ status: 'PENDING', invoiceAmount: 700 }),
      inv({ status: 'APPROVED', invoiceAmount: 300, invoiceBalance: 300 }),
      inv({ status: 'PAID', paidDate: '2026-09-25', invoiceAmount: 2000 }),
      inv({ status: 'REJECTED', invoiceAmount: 9000 }),
    ], '2026-09-30');
    expect(p.openAr).toBe(1500); // funded only: the approved $300 isn't funded yet
    expect(p.openArCount).toBe(2);
    expect(p.reserveHeld).toBe(120);
    expect(p.pendingAmount).toBe(1000); // sent in, not funded: pending $700 + approved $300
    expect(p.pendingCount).toBe(2);
    expect(p.approvedAmount).toBe(300);
    expect(p.creditExposure).toBe(1800); // credit counts funded and approved, like FactorCloud
    expect(p.aging[3]).toBe(500); // four months old
    expect(p.aging[0]).toBe(1000);
  });
});
