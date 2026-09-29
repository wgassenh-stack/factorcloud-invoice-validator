import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const fc = vi.hoisted(() => ({
  getInvoice: vi.fn(), getInvoiceLabels: vi.fn(), setInvoiceLabels: vi.fn(), updateInvoiceNotes: vi.fn(), listInvoiceLabels: vi.fn(),
}));
vi.mock('./factorcloud', () => fc);

import { decisionLine, labelsAfter, syncDecisionToFactorCloud } from './decision-sync';
import { buildPortalNote, portalUpdateNote, readPortalNote } from './portal-notes';

const LABELS = [{ id: 'l-oos', name: 'OOS' }, { id: 'l-review', name: 'Portal review.' }, { id: 'l-rejected', name: 'Portal rejected' }];

describe('what a decision does to the labels', () => {
  it('approve takes the review label off and keeps the rest', () => {
    expect(labelsAfter('APPROVE', ['l-oos', 'l-review'], 'l-review', null)).toEqual(['l-oos']);
  });
  it('reject swaps it for the rejected label when there is one, else leaves it', () => {
    expect(labelsAfter('REJECT', ['l-review'], 'l-review', 'l-rejected')).toEqual(['l-rejected']);
    expect(labelsAfter('REJECT', ['l-review'], 'l-review', null)).toBeNull();
  });
  it('a fix request, or no review label set up, changes nothing', () => {
    expect(labelsAfter('REQUEST_FIX', ['l-review'], 'l-review', null)).toBeNull();
    expect(labelsAfter('APPROVE', ['l-oos'], null, null)).toBeNull();
    expect(labelsAfter('APPROVE', ['l-oos'], 'l-review', null)).toBeNull();
  });
});

describe('the decision line in FactorCloud notes', () => {
  it('reads plainly and is appended after the client note without swallowing it', () => {
    const line = decisionLine('REJECT', 'Factor Admin', 'Wrong load on the BOL.', new Date('2026-09-29T15:00:00Z'));
    expect(line).toBe('rejected in the portal by Factor Admin on 2026-09-29: Wrong load on the BOL.');
    const notes = portalUpdateNote(buildPortalNote({ review: true, sender: 'Driver', clientNote: 'Lumper fee' }), line);
    expect(notes.endsWith('| Portal update: rejected in the portal by Factor Admin on 2026-09-29: Wrong load on the BOL.')).toBe(true);
    expect(readPortalNote(notes).clientNote).toBe('Lumper fee');
  });
});

describe('writing a decision back to FactorCloud', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FACTORCLOUD_REVIEW_LABEL_ID;
    fc.listInvoiceLabels.mockResolvedValue(LABELS);
    fc.getInvoice.mockResolvedValue({ invoice: { id: 'inv-1', notes: 'Submitted through FactorCloud client portal | PORTAL REVIEW REQUIRED' } });
    fc.updateInvoiceNotes.mockResolvedValue({});
    fc.setInvoiceLabels.mockResolvedValue({});
  });

  it('approve: appends the note and removes the review label', async () => {
    fc.getInvoiceLabels.mockResolvedValueOnce([LABELS[0], LABELS[1]]).mockResolvedValueOnce([LABELS[0]]);
    const out = await syncDecisionToFactorCloud({ invoiceId: 'inv-1', decision: 'APPROVE', reviewer: 'Factor Admin', note: null });
    expect(out.ok).toBe(true);
    expect(fc.updateInvoiceNotes.mock.calls[0][1]).toMatch(/PORTAL REVIEW REQUIRED \| Portal update: approved in the portal by Factor Admin on \d{4}-\d{2}-\d{2}$/);
    expect(fc.setInvoiceLabels).toHaveBeenCalledWith('inv-1', ['l-oos']);
  });

  it('says so when FactorCloud keeps the label anyway', async () => {
    fc.getInvoiceLabels.mockResolvedValue([LABELS[1]]);
    const out = await syncDecisionToFactorCloud({ invoiceId: 'inv-1', decision: 'APPROVE', reviewer: 'Factor Admin', note: null });
    expect(out).toMatchObject({ ok: false });
    expect(out.detail).toMatch(/labels could not be changed/);
  });

  it('never throws when FactorCloud is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fc.getInvoice.mockRejectedValue(new Error('503'));
    fc.getInvoiceLabels.mockRejectedValue(new Error('503'));
    const out = await syncDecisionToFactorCloud({ invoiceId: 'inv-1', decision: 'REJECT', reviewer: 'Factor Admin', note: 'No POD' });
    expect(out.ok).toBe(false);
  });

  it('a fix request only adds the note', async () => {
    const out = await syncDecisionToFactorCloud({ invoiceId: 'inv-1', decision: 'REQUEST_FIX', reviewer: 'Factor Admin', note: 'Send the signed POD' });
    expect(out.ok).toBe(true);
    expect(fc.setInvoiceLabels).not.toHaveBeenCalled();
    expect(fc.updateInvoiceNotes.mock.calls[0][1]).toContain('fix requested from the client by Factor Admin');
  });
});
