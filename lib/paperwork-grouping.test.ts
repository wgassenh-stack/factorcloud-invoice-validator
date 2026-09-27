import { describe, expect, it } from 'vitest';
import { groupPaperwork, groupingProblem } from './paperwork-grouping';
import type { AnalyzedDocument, ExtractedFields } from './types';

function doc(fileName: string, overrides: Partial<ExtractedFields>): AnalyzedDocument {
  return {
    fileName,
    fields: {
      documentType: 'other', invoiceNumber: null, referenceNumber: null, documentDate: null, clientName: null, debtorName: null,
      debtorAddress: null, debtorCity: null, debtorState: null, debtorZip: null, debtorPhone: null, debtorEmail: null, debtorEin: null,
      invoiceAmount: null, invoiceDate: null, dueDate: null, signaturePresent: null, uncertainFields: [], notes: null, ...overrides,
    },
  };
}

const names = (docs: AnalyzedDocument[], groups: number[][]) => groups.map((g) => g.map((i) => docs[i].fileName));

describe('grouping paperwork into invoices', () => {
  it('matches support documents by load number', () => {
    const docs = [
      doc('invoice-a', { documentType: 'invoice', invoiceNumber: 'A-1', referenceNumber: 'LOAD-A', debtorName: 'Acme LLC', invoiceAmount: 1000 }),
      doc('invoice-b', { documentType: 'invoice', invoiceNumber: 'B-1', referenceNumber: 'LOAD-B', debtorName: 'Acme LLC', invoiceAmount: 2000 }),
      doc('pod-b', { documentType: 'pod', referenceNumber: 'load b' }),
      doc('rate-a', { documentType: 'rate_confirmation', referenceNumber: 'LOAD-A' }),
    ];
    const out = groupPaperwork(docs);
    expect(names(docs, out.groups)).toEqual([['invoice-a', 'rate-a'], ['invoice-b', 'pod-b']]);
    expect(out.unassigned).toEqual([]);
  });

  it('falls back to invoice number, then a rate con with the same customer and amount', () => {
    const docs = [
      doc('invoice-a', { documentType: 'invoice', invoiceNumber: 'A-1', debtorName: 'Acme LLC', invoiceAmount: 1000 }),
      doc('invoice-b', { documentType: 'invoice', invoiceNumber: 'B-1', debtorName: 'Acme LLC', invoiceAmount: 2000 }),
      doc('bol-a', { documentType: 'bol', invoiceNumber: 'A-1' }),
      doc('rate-b', { documentType: 'rate_confirmation', debtorName: 'Acme, LLC', invoiceAmount: 2000 }),
    ];
    expect(names(docs, groupPaperwork(docs).groups)).toEqual([['invoice-a', 'bol-a'], ['invoice-b', 'rate-b']]);
  });

  it('puts photos from the same camera load together when nothing else matches', () => {
    const docs = [
      doc('photo-L1-1', { documentType: 'invoice', invoiceNumber: 'A-1' }),
      doc('photo-L1-2', { documentType: 'pod' }),
      doc('photo-L2-1', { documentType: 'invoice', invoiceNumber: 'B-1' }),
      doc('photo-L2-2', { documentType: 'bol' }),
      doc('upload.pdf', { documentType: 'pod' }),
    ];
    const out = groupPaperwork(docs, [1, 1, 2, 2, null]);
    expect(names(docs, out.groups)).toEqual([['photo-L1-1', 'photo-L1-2'], ['photo-L2-1', 'photo-L2-2']]);
    expect(out.unassigned).toEqual([4]);
  });

  it('never guesses: a load number shared by two invoices leaves the document for a person', () => {
    const docs = [
      doc('invoice-a', { documentType: 'invoice', referenceNumber: 'LOAD-X' }),
      doc('invoice-b', { documentType: 'invoice', referenceNumber: 'LOAD-X' }),
      doc('pod', { documentType: 'pod', referenceNumber: 'LOAD-X' }),
    ];
    expect(groupPaperwork(docs, [1, null, 1]).unassigned).toEqual([2]);
  });

  it('sends everything with the only invoice, and places nothing without one', () => {
    const one = [doc('bol', { documentType: 'bol', referenceNumber: 'OTHER' }), doc('invoice', { documentType: 'invoice' })];
    expect(groupPaperwork(one)).toEqual({ groups: [[1, 0]], unassigned: [] });
    expect(groupPaperwork([doc('pod', { documentType: 'pod' })])).toEqual({ groups: [], unassigned: [0] });
  });

  it('rejects a grouping sent back with missing, repeated or empty entries', () => {
    expect(groupingProblem([[0, 1], [2]], 3)).toBeNull();
    expect(groupingProblem([[0, 1], [1]], 3)).toMatch(/more than one group/);
    expect(groupingProblem([[0, 5]], 3)).toMatch(/does not exist/);
    expect(groupingProblem([[0], []], 3)).toMatch(/at least one/);
    expect(groupingProblem([], 3)).toMatch(/Nothing/);
  });
});

describe('suggesting where an unplaced document goes', () => {
  it('ranks a one-typo load number, the same camera load, and an invoice missing that kind of document', async () => {
    const { suggestPlacements } = await import('./paperwork-grouping');
    const docs = [
      doc('invoice-a', { documentType: 'invoice', referenceNumber: 'LD448213' }),
      doc('invoice-b', { documentType: 'invoice', referenceNumber: 'LD448299' }),
      doc('pod-typo', { documentType: 'pod', referenceNumber: 'LD448218' }),
      doc('pod-blurry', { documentType: 'pod' }),
    ];
    const groups = [[0], [1]];
    expect(suggestPlacements(docs, groups, [2])).toEqual({ 2: [0] });
    expect(suggestPlacements(docs, groups, [3], [null, 2, null, 2])).toEqual({ 3: [1] });
    // Nothing to go on, and both invoices lack a POD: no suggestion rather than a guess.
    expect(suggestPlacements(docs, groups, [3])).toEqual({ 3: [] });
    // Only one invoice lacks a POD: suggest it.
    const withPod = [...docs, doc('pod-a', { documentType: 'pod', referenceNumber: 'LD448213' })];
    expect(suggestPlacements(withPod, [[0, 4], [1]], [3])).toEqual({ 3: [1] });
  });
});
