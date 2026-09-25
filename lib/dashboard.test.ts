import { describe, expect, it } from 'vitest';
import { averageInvoiceAmount, buildStatusMix, buildWeeklyActivity, periodAmount, trendPercent } from './dashboard';
import type { RiskInvoiceRecord } from './risk';

const record = (overrides: Partial<RiskInvoiceRecord>): RiskInvoiceRecord => ({
  id: overrides.id || crypto.randomUUID(),
  invoiceNumber: overrides.invoiceNumber ?? 'INV-1',
  companyClientId: overrides.companyClientId ?? 'client-1',
  companyDebtorId: overrides.companyDebtorId ?? 'debtor-1',
  invoiceAmount: overrides.invoiceAmount ?? 100,
  invoiceDate: overrides.invoiceDate ?? '2026-09-25',
  status: overrides.status ?? 'PENDING',
  notes: overrides.notes ?? null,
});

describe('dashboard summaries', () => {
  it('builds weekly buckets and ignores activity outside the window', () => {
    const points = buildWeeklyActivity([
      record({ invoiceDate: '2026-09-25', invoiceAmount: 100 }),
      record({ invoiceDate: '2026-09-21', invoiceAmount: 50 }),
      record({ invoiceDate: '2026-09-14', invoiceAmount: 25 }),
      record({ invoiceDate: '2026-07-01', invoiceAmount: 999 }),
    ], 3, new Date('2026-09-25T12:00:00Z'));

    expect(points).toHaveLength(3);
    expect(points.map((point) => point.amount)).toEqual([0, 25, 150]);
    expect(points.map((point) => point.count)).toEqual([0, 1, 2]);
  });

  it('summarizes statuses by count and amount', () => {
    const items = buildStatusMix([
      record({ status: 'PENDING', invoiceAmount: 100 }),
      record({ status: 'PENDING', invoiceAmount: 200 }),
      record({ status: 'FUNDED', invoiceAmount: 300 }),
    ]);

    expect(items[0]).toMatchObject({ status: 'PENDING', count: 2, amount: 300 });
    expect(items[1]).toMatchObject({ status: 'FUNDED', count: 1, amount: 300 });
  });

  it('calculates period totals and average invoice amount', () => {
    const records = [
      record({ invoiceDate: '2026-09-25', invoiceAmount: 100 }),
      record({ invoiceDate: '2026-09-01', invoiceAmount: 200 }),
      record({ invoiceDate: '2026-08-20', invoiceAmount: 300 }),
    ];
    const anchor = new Date('2026-09-25T12:00:00Z');

    expect(periodAmount(records, 30, anchor)).toBe(300);
    expect(periodAmount(records, 30, anchor, 30)).toBe(300);
    expect(averageInvoiceAmount(records)).toBe(200);
  });

  it('calculates percentage change when there is a baseline', () => {
    expect(trendPercent(150, 100)).toBe(50);
    expect(trendPercent(50, 100)).toBe(-50);
    expect(trendPercent(0, 0)).toBe(0);
    expect(trendPercent(100, 0)).toBeNull();
  });
});
