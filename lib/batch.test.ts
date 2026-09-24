import { describe, expect, it } from 'vitest';
import { groupIntoInvoicePackets } from './batch';
import type { AnalyzedDocument, ExtractedFields } from './types';

function fields(overrides: Partial<ExtractedFields>): ExtractedFields {
  return {
    documentType: 'other',
    invoiceNumber: null,
    referenceNumber: null,
    documentDate: null,
    clientName: null,
    debtorName: null,
    debtorAddress: null,
    debtorCity: null,
    debtorState: null,
    debtorZip: null,
    debtorPhone: null,
    debtorEmail: null,
    debtorEin: null,
    invoiceAmount: null,
    invoiceDate: null,
    dueDate: null,
    signaturePresent: null,
    uncertainFields: [],
    notes: null,
    ...overrides,
  };
}

function doc(fileName: string, overrides: Partial<ExtractedFields>): AnalyzedDocument {
  return { fileName, fields: fields(overrides) };
}

describe('batch grouping', () => {
  it('groups supporting documents to invoices by reference number', () => {
    const result = groupIntoInvoicePackets([
      doc('invoice-a.pdf', { documentType: 'invoice', invoiceNumber: 'A-1', referenceNumber: 'LOAD-A', debtorName: 'Acme LLC', invoiceAmount: 1000 }),
      doc('invoice-b.pdf', { documentType: 'invoice', invoiceNumber: 'B-1', referenceNumber: 'LOAD-B', debtorName: 'Acme LLC', invoiceAmount: 2000 }),
      doc('pod-b.pdf', { documentType: 'pod', referenceNumber: 'LOAD-B' }),
      doc('rate-a.pdf', { documentType: 'rate_confirmation', referenceNumber: 'LOAD-A', debtorName: 'Acme LLC', invoiceAmount: 1000 }),
    ]);

    expect(result.packets).toHaveLength(2);
    expect(result.packets[0].documents.map((d) => d.fileName)).toEqual(['invoice-a.pdf', 'rate-a.pdf']);
    expect(result.packets[1].documents.map((d) => d.fileName)).toEqual(['invoice-b.pdf', 'pod-b.pdf']);
    expect(result.unassignedDocuments).toHaveLength(0);
  });

  it('uses debtor plus rate amount only when that identifies one invoice', () => {
    const result = groupIntoInvoicePackets([
      doc('invoice-a.pdf', { documentType: 'invoice', invoiceNumber: 'A-1', debtorName: 'Acme LLC', invoiceAmount: 1000 }),
      doc('invoice-b.pdf', { documentType: 'invoice', invoiceNumber: 'B-1', debtorName: 'Acme LLC', invoiceAmount: 2000 }),
      doc('rate-b.pdf', { documentType: 'rate_confirmation', debtorName: 'Acme LLC', invoiceAmount: 2000 }),
    ]);

    expect(result.packets[1].documents.map((d) => d.fileName)).toEqual(['invoice-b.pdf', 'rate-b.pdf']);
    expect(result.unassignedDocuments).toHaveLength(0);
  });

  it('leaves ambiguous support documents unassigned', () => {
    const result = groupIntoInvoicePackets([
      doc('invoice-a.pdf', { documentType: 'invoice', invoiceNumber: 'A-1', referenceNumber: 'LOAD-X' }),
      doc('invoice-b.pdf', { documentType: 'invoice', invoiceNumber: 'B-1', referenceNumber: 'LOAD-X' }),
      doc('pod.pdf', { documentType: 'pod', referenceNumber: 'LOAD-X' }),
    ]);

    expect(result.unassignedDocuments.map((d) => d.fileName)).toEqual(['pod.pdf']);
  });

  it('returns everything unassigned when no invoice is detected', () => {
    const documents = [doc('pod.pdf', { documentType: 'pod', referenceNumber: 'LOAD-A' })];
    const result = groupIntoInvoicePackets(documents);
    expect(result.packets).toHaveLength(0);
    expect(result.unassignedDocuments).toEqual(documents);
  });
});
