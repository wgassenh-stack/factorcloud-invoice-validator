import { describe, expect, it } from 'vitest';
import { buildAging, buildCashSummary, buildDailyVolume, buildDsoTrend, buildExposure, buildKpis, buildMonthlyCash, isPaid, lifecycleStage, openBalance } from './analytics';
import type { RiskInvoiceRecord } from './risk';

const TODAY = '2026-09-25';
const inv = (id: string, over: Partial<RiskInvoiceRecord>): RiskInvoiceRecord => ({
  id, invoiceNumber: id, companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 1000, invoiceDate: '2026-09-20', status: 'FUNDED', ...over,
});

describe('portfolio analytics', () => {
  const records = [
    inv('fresh', { fundedDate: '2026-09-21', advanceAmount: 900, escrowReserveAmount: 100, purchaseFeeAmount: 20 }),
    inv('old', { invoiceDate: '2026-06-01', fundedDate: '2026-06-02', invoiceBalance: 400, companyClientId: 'c2' }),
    inv('paid', { invoiceDate: '2026-08-01', fundedDate: '2026-08-02', paidDate: '2026-09-10', status: 'PAID', advanceAmount: 900, purchaseFeeAmount: 30 }),
    inv('pending', { status: 'PENDING', verificationStatus: 'PENDING' }),
  ];

  it('ages open funded balances into buckets by group', () => {
    const aging = buildAging(records, { c1: 'One', c2: 'Two' }, TODAY);
    expect(aging.totals).toEqual([1000, 0, 0, 400]);
    expect(aging.rows.map((r) => r.label)).toEqual(['One', 'Two']);
    expect(aging.openCount).toBe(2);
  });

  it('flags concentrated exposure', () => {
    const exposure = buildExposure(records, {});
    expect(exposure[0]).toMatchObject({ id: 'c1', level: 'HIGH' });
    expect(exposure[0].share).toBeCloseTo(1000 / 1400);
  });

  it('places each invoice on the lifecycle', () => {
    expect(records.map(lifecycleStage)).toEqual(['FUNDED', 'FUNDED', 'PAID', 'SUBMITTED']);
    expect(lifecycleStage(inv('v', { status: 'APPROVED' }))).toBe('VERIFIED');
  });

  it('sums cash by month and days to pay', () => {
    const cash = buildMonthlyCash(records, TODAY, 3);
    expect(cash.map((m) => m.key)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(cash[2]).toMatchObject({ advanced: 900, collected: 1000, fees: 30 });
    expect(buildDsoTrend(records, TODAY, 1)[0].days).toBe(40);
    expect(buildKpis(records, TODAY)).toMatchObject({ openBalance: 1400, fundedLast30: 900, collectedLast30: 1000, dsoLast90: 40 });
  });

  it('builds a calendar that ends today and starts on a Monday', () => {
    const days = buildDailyVolume(records, TODAY, 2);
    expect(days.at(-1)!.date).toBe(TODAY);
    expect(new Date(`${days[0].date}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(days.find((d) => d.date === '2026-09-20')!.count).toBe(2);
  });

  it('summarizes a client cash picture', () => {
    const summary = buildCashSummary(records, TODAY);
    expect(summary.waitingOnFactor).toEqual({ count: 1, amount: 1000, oldestDays: 5 });
    expect(summary.withDebtors).toEqual({ count: 2, amount: 2000, advanced: 900, fees: 20, reserveBack: 80, notBrokenOut: 1000, stillOwed: 1400, balanceAssumed: 1 });
    expect(summary.over60).toEqual({ count: 1, amount: 400 });
    expect(summary.last30).toEqual({ advanced: 900, reserveReleased: 70, fees: 30 });
    expect(summary.pipeline.map((p) => p.count)).toEqual([1, 0, 2, 1]);
  });

  it('splits money on funded invoices into parts that always add up', () => {
    const { withDebtors, last30 } = buildCashSummary([
      inv('a', { invoiceAmount: 1000, fundedDate: '2026-09-21', advanceAmount: 900, purchaseFeeAmount: 25, escrowReserveAmount: 100 }),
      inv('b', { invoiceAmount: 500, fundedDate: '2026-09-21', advanceAmount: 480, purchaseFeeAmount: 60 }),
      inv('p', { invoiceDate: '2026-08-20', fundedDate: '2026-08-21', paidDate: '2026-09-15', status: 'PAID', advanceAmount: 900, purchaseFeeAmount: 30, escrowReserveAmount: 100 }),
    ], TODAY);
    expect(withDebtors.advanced + withDebtors.fees + withDebtors.reserveBack + withDebtors.notBrokenOut).toBe(withDebtors.amount);
    expect(withDebtors).toMatchObject({ amount: 1500, advanced: 1380, fees: 45, reserveBack: 75 });
    expect(last30).toEqual({ advanced: 1380, reserveReleased: 100, fees: 30 });
  });

  it('reads the reserve the way FactorCloud splits an invoice (advance + reserve + fee = amount)', async () => {
    const { reserveOn, balanceReported } = await import('./analytics');
    // FactorCloud invoice Test008: $9,750 = $8,190 advance + $1,462.50 escrow reserve + $97.50 fee.
    const test008 = inv('Test008', { invoiceAmount: 9750, invoiceBalance: 9750, advanceAmount: 8190, escrowReserveAmount: 1462.5, purchaseFeeAmount: 97.5 });
    expect(reserveOn(test008)).toBe(1462.5);
    expect(reserveOn({ ...test008, escrowReserveAmount: null })).toBe(1462.5);
    expect(reserveOn({ ...test008, escrowReserveAmount: null, advanceAmount: null })).toBe(0);
    expect(balanceReported(test008)).toBe(true);
    expect(balanceReported({ ...test008, invoiceBalance: null })).toBe(false);
  });

  it('reads FactorCloud status values whole, not as substrings', () => {
    expect(lifecycleStage(inv('nv', { status: 'PENDING', verificationStatus: 'NOT_VERIFIED' }))).toBe('SUBMITTED');
    expect(lifecycleStage(inv('need', { status: 'NEED_VERIFIED', verificationStatus: 'PENDING' }))).toBe('SUBMITTED');
    expect(lifecycleStage(inv('denied', { status: 'HELD', verificationStatus: 'DENIED' }))).toBe('SUBMITTED');
    expect(lifecycleStage(inv('ver', { status: 'PENDING', verificationStatus: 'VERIFIED' }))).toBe('VERIFIED');
    expect(lifecycleStage(inv('purch', { status: 'PURCHASED' }))).toBe('FUNDED');
    expect(isPaid(inv('unpaid', { status: 'FUNDED', paymentStatus: 'Unpaid' }))).toBe(false);
    expect(isPaid(inv('open', { status: 'FUNDED', paymentStatus: 'Open' }))).toBe(false);
    expect(isPaid(inv('paid', { status: 'FUNDED', paymentStatus: 'Paid' }))).toBe(true);
    expect(openBalance(inv('rej', { status: 'REJECTED' }))).toBe(0);
    expect(buildCashSummary([inv('rej', { status: 'REJECTED' }), inv('can', { status: 'CANCELED' })], TODAY).pipeline.every((p) => p.count === 0)).toBe(true);
  });
});
