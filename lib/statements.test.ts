import { describe, expect, it } from 'vitest';
import { buildStatement, statementCsv, statementMonths } from './statements';
import type { RiskInvoiceRecord } from './risk';

const inv = (id: string, over: Partial<RiskInvoiceRecord>): RiskInvoiceRecord => ({
  id, invoiceNumber: id, companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 1000, invoiceDate: '2026-09-02', status: 'FUNDED', ...over,
});

describe('client statements', () => {
  const records = [
    inv('A-1', { createdOn: '2026-09-02', fundedDate: '2026-09-03', advanceAmount: 900, escrowReserveAmount: 100, purchaseFeeAmount: 25 }),
    // Advance + escrow reserve + fee add up to the invoice amount, as in FactorCloud.
    inv('A-2', { invoiceDate: '2026-08-10', createdOn: '2026-08-10', fundedDate: '2026-08-11', paidDate: '2026-09-15', status: 'PAID', advanceAmount: 870, escrowReserveAmount: 100, purchaseFeeAmount: 30 }),
    inv('A-3', { createdOn: '2026-09-20', status: 'REJECTED' }),
  ];

  it('sums what was funded and paid in the month', () => {
    const s = buildStatement(records, '2026-09');
    expect(s.submitted).toEqual({ count: 1, amount: 1000 });
    expect(s.funded).toEqual({ count: 1, amount: 1000, advanced: 900 });
    expect(s.paid).toEqual({ count: 1, amount: 1000, reserveReleased: 100, fees: 30 });
    expect(s.totalToClient).toBe(1000);
    expect(s.openToday).toEqual({ count: 1, balance: 1000 });
    expect(s.lines.map((l) => `${l.date} ${l.kind} ${l.invoiceNumber}`)).toEqual(['2026-09-03 FUNDED A-1', '2026-09-15 PAID A-2']);
  });

  it('writes a CSV with escaped names and a totals row', () => {
    const csv = statementCsv(buildStatement(records, '2026-09'), { d1: 'Acme, "Big" LLC' });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Event,Invoice,Debtor,Invoice amount,To you,Fee');
    expect(lines[1]).toContain('"Acme, ""Big"" LLC"');
    expect(lines.at(-1)).toBe(',Total,,,,1000.00,30.00');
  });

  it('lists the last twelve months, newest first', () => {
    const months = statementMonths('2026-09-26');
    expect(months[0]).toBe('2026-09');
    expect(months[11]).toBe('2025-10');
  });
});
