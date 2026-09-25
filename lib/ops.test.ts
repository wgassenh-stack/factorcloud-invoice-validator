import { describe, expect, it } from 'vitest';
import { summarizeClients } from './ops';

describe('factor operations client summaries', () => {
  it('groups invoice records by positive client id and ignores unscoped records', () => {
    const summary = summarizeClients([
      { id: '1', invoiceNumber: 'A', companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 100, invoiceDate: '2026-09-20', status: 'PENDING' },
      { id: '2', invoiceNumber: 'B', companyClientId: 'c1', companyDebtorId: 'd2', invoiceAmount: 200, invoiceDate: '2026-09-24', status: 'VERIFIED' },
      { id: '3', invoiceNumber: 'C', companyClientId: 'c2', companyDebtorId: 'd3', invoiceAmount: 50, invoiceDate: '2026-09-22', status: 'PENDING' },
      { id: '4', invoiceNumber: 'D', companyClientId: null, companyDebtorId: 'd4', invoiceAmount: 999, invoiceDate: '2026-09-25', status: 'PENDING' },
    ], { c1: 'Client One', c2: 'Client Two' });

    expect(summary).toHaveLength(2);
    const c1 = summary.find((client) => client.clientId === 'c1');
    expect(c1?.clientName).toBe('Client One');
    expect(c1?.invoiceCount).toBe(2);
    expect(c1?.invoiceAmount).toBe(300);
    expect(c1?.latestInvoiceDate).toBe('2026-09-24');
    expect(c1?.statuses).toEqual({ PENDING: 1, VERIFIED: 1 });
  });
});
