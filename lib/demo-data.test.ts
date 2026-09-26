import { describe, expect, it } from 'vitest';
import { buildDemoPortfolio, buildDemoReviews } from './demo-data';
import { DEMO_CLIENT_ID } from './demo';
import { collectRiskInvoiceRecords, summarizeRisk } from './risk';

const TODAY = '2026-09-25';

describe('demo portfolio', () => {
  const portfolio = buildDemoPortfolio(TODAY, 'Demo Trucking LLC');
  const records = collectRiskInvoiceRecords({ invoices: portfolio.invoices });

  it('is deterministic', () => {
    const again = buildDemoPortfolio(TODAY, 'Demo Trucking LLC');
    expect(again.invoices).toEqual(portfolio.invoices);
  });

  it('has a realistic size with unique ids', () => {
    expect(portfolio.clients).toHaveLength(20);
    expect(portfolio.debtors).toHaveLength(60);
    expect(new Set(portfolio.invoices.map((i) => i.id)).size).toBe(portfolio.invoices.length);
    expect(portfolio.invoices.length).toBeGreaterThan(1500);
    expect(portfolio.invoices.every((i) => i.invoiceDate.slice(0, 10) <= TODAY)).toBe(true);
    expect(portfolio.invoices.every((i) => !i.paidDate || i.paidDate.slice(0, 10) <= TODAY)).toBe(true);
  });

  it('plants the demo stories on the portal client', () => {
    const own = records.filter((r) => r.companyClientId === DEMO_CLIENT_ID);
    const names = Object.fromEntries(portfolio.debtors.map((d) => [d.id, d.companyName ?? d.id]));
    const summary = summarizeRisk(own, names, TODAY);
    expect(summary.concentrations[0].debtorName).toBe('Acme Manufacturing LLC');
    expect(summary.concentrations[0].share).toBeGreaterThan(0.35);
    expect(summary.concentrations[0].share).toBeLessThan(0.55);
    expect(summary.volumeRatio).toBeGreaterThan(1.5);
    const oldestOpen = own.filter((r) => r.invoiceBalance && r.status !== 'PAID').map((r) => r.invoiceDate!).sort()[0];
    expect((Date.parse(TODAY) - Date.parse(oldestOpen)) / 86_400_000).toBeGreaterThan(90);
  });

  it('seeds open review items on unverified invoices', () => {
    const reviews = buildDemoReviews(portfolio, Date.parse(`${TODAY}T15:00:00Z`));
    expect(reviews.length).toBeGreaterThanOrEqual(5);
    const byId = new Map(portfolio.invoices.map((i) => [i.id, i]));
    expect(reviews.every((r) => byId.get(r.invoiceId)?.status === 'PENDING')).toBe(true);
  });
});
