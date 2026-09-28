import { describe, expect, it } from 'vitest';
import { addDemoInvoice, demoArrivalsToday, demoReviews, recordDemoSubmission } from './demo-store';
import { DEMO_CLIENT_ID } from './demo';

describe('demo "arrived today"', () => {
  it('starts with a few clean invoices from today, newest first, none of them in review', () => {
    const arrivals = demoArrivalsToday();
    const today = new Date().toISOString().slice(0, 10);
    expect(arrivals.length).toBeGreaterThan(0);
    expect(arrivals.every((a) => a.createdAt.startsWith(today))).toBe(true);
    expect(arrivals.map((a) => a.createdAt)).toEqual(arrivals.map((a) => a.createdAt).sort().reverse());
    const reviewed = new Set(demoReviews().map((r) => r.invoiceId));
    expect(arrivals.some((a) => reviewed.has(a.invoiceId))).toBe(false);
  });

  it('lists a clean submission and leaves a flagged one to the review queue', () => {
    const before = demoArrivalsToday().length;
    const send = (invoiceNumber: string, status: 'PASS' | 'REVIEW') => {
      const invoice = addDemoInvoice({ invoiceNumber, referenceNumber: null, companyClientId: DEMO_CLIENT_ID, companyDebtorId: 'demo-debtor-01', invoiceAmount: 1200, invoiceDate: '2026-09-25', notes: null });
      recordDemoSubmission({ invoiceId: invoice.id, clientId: DEMO_CLIENT_ID, debtorId: 'demo-debtor-01', validation: { status, checks: [] }, files: [{ fileName: 'a.pdf', documentType: 'invoice', sizeBytes: 1 }] });
      return invoice;
    };
    const clean = send('ARR-1', 'PASS');
    send('ARR-2', 'REVIEW');
    const after = demoArrivalsToday();
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toMatchObject({ invoiceId: clean.id, invoiceNumber: 'ARR-1', documentCount: 1 });
  });
});
