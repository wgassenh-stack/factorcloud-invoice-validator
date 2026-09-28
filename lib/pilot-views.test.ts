import { describe, expect, it } from 'vitest';
import { cleanArrivals, driverRows, flaggedForReview } from './pilot-views';
import { PORTAL_NOTE, REVIEW_NOTE, readPortalNote, sentByNote } from './portal-notes';
import type { RiskInvoiceRecord } from './risk';

const TODAY = '2026-09-28';
let n = 0;
const invoice = (over: Partial<RiskInvoiceRecord>): RiskInvoiceRecord => ({
  id: `inv-${++n}`, invoiceNumber: `FCB-${n}`, companyClientId: 'client-1', companyDebtorId: 'debtor-1',
  invoiceAmount: 1000, invoiceDate: TODAY, status: 'PENDING', createdOn: `${TODAY}T15:00:00Z`, ...over,
});
const note = (...parts: (string | null)[]) => parts.filter(Boolean).join(' | ');

describe('reading the portal note', () => {
  it('reads who sent it, whether it was flagged, and the client note', () => {
    expect(readPortalNote(note(PORTAL_NOTE, REVIEW_NOTE, sentByNote('Driver'), 'Client note: Lumper fee at delivery'))).toEqual({
      viaPortal: true, flagged: true, sentBy: 'Driver', clientNote: 'Lumper fee at delivery',
    });
    expect(readPortalNote('Keyed in by the office')).toEqual({ viaPortal: false, flagged: false, sentBy: null, clientNote: null });
    expect(readPortalNote(null).viaPortal).toBe(false);
  });
});

describe('Factor view without the portal database', () => {
  const flaggedOpen = invoice({ notes: note(PORTAL_NOTE, REVIEW_NOTE) });
  const flaggedApproved = invoice({ notes: note(PORTAL_NOTE, REVIEW_NOTE), status: 'APPROVED' });
  const flaggedRejected = invoice({ notes: note(PORTAL_NOTE, REVIEW_NOTE), status: 'REJECTED' });
  const clean = invoice({ notes: note(PORTAL_NOTE, sentByNote('Office')) });
  const cleanYesterday = invoice({ notes: PORTAL_NOTE, createdOn: '2026-09-27T20:00:00Z' });
  const keyedIn = invoice({ notes: null });
  const all = [flaggedOpen, flaggedApproved, flaggedRejected, clean, cleanYesterday, keyedIn];

  it('lists flagged invoices until the factor decides on them in FactorCloud', () => {
    expect(flaggedForReview(all).map((r) => r.id)).toEqual([flaggedOpen.id]);
  });

  it('lists clean portal invoices from today only', () => {
    expect(cleanArrivals(all, TODAY).map((r) => r.id)).toEqual([clean.id]);
  });
});

describe('Driver view without the portal database', () => {
  it("lists only this client's invoices sent from the Driver view, anything needing the driver first", () => {
    const sent = invoice({ notes: note(PORTAL_NOTE, sentByNote('Driver')), createdOn: `${TODAY}T16:00:00Z` });
    const rejected = invoice({ notes: note(PORTAL_NOTE, sentByNote('Driver')), status: 'REJECTED', createdOn: '2026-09-20T10:00:00Z' });
    const flagged = invoice({ notes: note(PORTAL_NOTE, REVIEW_NOTE, sentByNote('Driver')) });
    const office = invoice({ notes: note(PORTAL_NOTE, sentByNote('Office')) });
    const otherClient = invoice({ notes: note(PORTAL_NOTE, sentByNote('Driver')), companyClientId: 'client-2' });
    const old = invoice({ notes: note(PORTAL_NOTE, sentByNote('Driver')), status: 'PAID', paidDate: '2026-06-01', createdOn: '2026-05-01T10:00:00Z' });
    const rows = driverRows([sent, rejected, flagged, office, otherClient, old], 'client-1', TODAY);
    expect(rows.map((r) => r.id)).toEqual([rejected.id, sent.id, flagged.id]);
    expect(rows[0].status.key).toBe('REJECTED');
    expect(rows.find((r) => r.id === flagged.id)?.status.key).toBe('CHECKING');
  });
});
