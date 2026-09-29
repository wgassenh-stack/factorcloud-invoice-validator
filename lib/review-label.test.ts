import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const fc = vi.hoisted(() => ({ listInvoiceLabels: vi.fn(), setInvoiceLabels: vi.fn() }));
vi.mock('./factorcloud', () => fc);

import { findReviewLabel, labelForReview, sameLabelName } from './review-label';
import { labelsIn } from './labels';

const LABELS = [
  { id: 'l-oos', name: 'OOS' },
  { id: 'l-review', name: 'Portal review.' },
  { id: 'l-first', name: 'First Funding' },
];

describe('the review label', () => {
  beforeEach(() => { vi.clearAllMocks(); delete process.env.FACTORCLOUD_REVIEW_LABEL_ID; delete process.env.FACTORCLOUD_REVIEW_LABEL; });

  it('is found by name, ignoring case and a trailing period', () => {
    expect(sameLabelName('Portal review.', 'portal review')).toBe(true);
    expect(sameLabelName('Portal reviewed', 'Portal review')).toBe(false);
    expect(findReviewLabel(LABELS)?.id).toBe('l-review');
    expect(findReviewLabel(LABELS, 'first funding')?.id).toBe('l-first');
    expect(findReviewLabel([{ id: 'x', name: 'OOS' }])).toBeNull();
  });

  it('goes on a flagged invoice the way FactorCloud sets labels', async () => {
    fc.listInvoiceLabels.mockResolvedValue(LABELS);
    fc.setInvoiceLabels.mockResolvedValue({ status: 'SUCCESS' });
    expect(await labelForReview('inv-1')).toMatchObject({ ok: true });
    expect(fc.setInvoiceLabels).toHaveBeenCalledWith('inv-1', ['l-review']);
  });

  it('never throws: a failure is reported and the invoice stands', async () => {
    fc.listInvoiceLabels.mockResolvedValue(LABELS);
    fc.setInvoiceLabels.mockRejectedValue(new Error('500 from FactorCloud'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await labelForReview('inv-2')).toMatchObject({ ok: false });
  });
});

describe('reading FactorCloud label lists', () => {
  it('finds id and name pairs however the response wraps them', () => {
    expect(labelsIn({ status: 'SUCCESS', labels: [{ id: 'a', name: 'OOS', category: { name: 'General' } }] })).toEqual([{ id: 'a', name: 'OOS' }]);
    expect(labelsIn([{ id: 'b', name: 'Portal review.' }])).toEqual([{ id: 'b', name: 'Portal review.' }]);
    expect(labelsIn({ data: { content: [{ id: 'c', name: 'X' }] } })).toEqual([{ id: 'c', name: 'X' }]);
  });
});

describe('reading funding instructions', () => {
  it('finds them however the response wraps them', async () => {
    const { fundingInstructionsIn } = await vi.importActual<typeof import('./funding-api')>('./funding-api');
    expect(fundingInstructionsIn({ paymentInformationList: [{ id: 'a', name: 'Ops', paymentMethod: 'ACH', default: true }] })).toEqual([{ id: 'a', name: 'Ops', paymentMethod: 'ACH', isDefault: true }]);
    expect(fundingInstructionsIn({ status: 'SUCCESS', fundingInstructions: [{ id: 'b', nickname: 'Test Check', paymentMethod: 'Check', payTo: 'X' }] })).toEqual([{ id: 'b', name: 'Test Check', paymentMethod: 'CHECK', isDefault: false }]);
    expect(fundingInstructionsIn({ data: { id: 'c', paymentMethod: 'SAME DAY ACH' } })[0].paymentMethod).toBe('SAME_DAY_ACH');
    expect(fundingInstructionsIn({ status: 'SUCCESS', code: 200 })).toEqual([]);
  });
});
