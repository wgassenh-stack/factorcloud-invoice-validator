import { describe, expect, it } from 'vitest';
import { collectRiskInvoiceRecords, summarizeRisk } from './risk';

describe('risk analytics', () => {
  it('collects invoice amount and date from nested FactorCloud responses', () => {
    const records = collectRiskInvoiceRecords({ data: { items: [{ id: 'i1', invoiceNumber: '100', companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 12500, invoiceDate: '2026-09-24T00:00:00Z', status: 'PENDING' }] } });
    expect(records).toEqual([{ id: 'i1', invoiceNumber: '100', companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 12500, invoiceDate: '2026-09-24', status: 'PENDING' }]);
  });

  it('flags debtor concentration above the configured threshold', () => {
    const summary = summarizeRisk([
      { id: '1', invoiceNumber: '1', companyClientId: 'c', companyDebtorId: 'a', invoiceAmount: 800, invoiceDate: '2026-09-24', status: 'PENDING' },
      { id: '2', invoiceNumber: '2', companyClientId: 'c', companyDebtorId: 'b', invoiceAmount: 200, invoiceDate: '2026-09-23', status: 'PENDING' },
    ], { a: 'Acme', b: 'Beta' }, '2026-09-24');
    expect(summary.concentrations[0].debtorName).toBe('Acme');
    expect(summary.concentrations[0].share).toBeCloseTo(0.8);
    expect(summary.concentrations[0].level).toBe('HIGH');
    expect(summary.alerts.some((alert) => alert.id === 'concentration-a')).toBe(true);
  });

  it('flags a recent volume spike versus the prior 28-day weekly pace', () => {
    const records = [
      { id: '1', invoiceNumber: '1', companyClientId: 'c', companyDebtorId: 'a', invoiceAmount: 1000, invoiceDate: '2026-09-24', status: 'PENDING' },
      { id: '2', invoiceNumber: '2', companyClientId: 'c', companyDebtorId: 'a', invoiceAmount: 400, invoiceDate: '2026-09-10', status: 'PENDING' },
    ];
    const summary = summarizeRisk(records, { a: 'Acme' }, '2026-09-24');
    expect(summary.volumeRatio).toBe(10);
    expect(summary.alerts.some((alert) => alert.id === 'volume-spike')).toBe(true);
  });
});
