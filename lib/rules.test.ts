import { describe, expect, it } from 'vitest';
import type { AnalyzedDocument, CompanyRecord, ExtractedFields } from './types';
import { validate } from './rules';

const debtor: CompanyRecord = {
  id: 'debtor-1',
  compCode: 'ACME1',
  companyName: 'Acme Manufacturing LLC',
  address1: 'Fake address',
  city: 'Dallas',
  stateCode: 'TX',
  zipCode: '75205',
  phone: '3343770535',
  ein: '987654321',
  noBuy: false,
};

const client: CompanyRecord = {
  id: 'client-1',
  companyName: "Will's Test Trucking LLC",
};

function fields(overrides: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    documentType: 'invoice',
    invoiceNumber: 'Test003',
    referenceNumber: 'Load003',
    documentDate: '2026-09-24',
    clientName: "Will's Test Trucking LLC",
    debtorName: 'Acme Manufacturing LLC',
    debtorAddress: 'Fake address',
    debtorCity: 'Dallas',
    debtorState: 'TX',
    debtorZip: '75205',
    debtorPhone: '3343770535',
    debtorEmail: null,
    debtorEin: '987654321',
    invoiceAmount: 12500,
    invoiceDate: '2026-09-24',
    dueDate: '2026-10-24',
    signaturePresent: null,
    uncertainFields: [],
    notes: null,
    ...overrides,
  };
}

function doc(overrides: Partial<ExtractedFields> = {}, fileName = 'invoice.pdf'): AnalyzedDocument {
  return { fileName, fields: fields(overrides) };
}

describe('validation rules', () => {
  it('passes a clean single invoice', () => {
    const result = validate({ documents: [doc()], primaryIndex: 0, debtor, client, today: '2026-09-24' });
    expect(result.status).toBe('PASS');
  });

  it('fails when no invoice document is detected', () => {
    const result = validate({ documents: [doc({ documentType: 'bol', invoiceDate: null, invoiceNumber: null, invoiceAmount: null })], primaryIndex: 0, debtor, client, today: '2026-09-24' });
    expect(result.status).toBe('FAIL');
    expect(result.checks.find((c) => c.id === 'invoice-document')?.status).toBe('FAIL');
  });

  it('fails a debtor marked No Buy', () => {
    const result = validate({ documents: [doc()], primaryIndex: 0, debtor: { ...debtor, noBuy: true }, client, today: '2026-09-24' });
    expect(result.status).toBe('FAIL');
  });

  it('reviews a close debtor name unless a second identifier corroborates it', () => {
    const result = validate({ documents: [doc({ debtorName: 'Acme Manufactring', debtorEin: null, debtorPhone: null })], primaryIndex: 0, debtor, client, today: '2026-09-24' });
    expect(result.status).toBe('REVIEW');
    expect(result.checks.find((c) => c.id === 'company-name')?.status).toBe('REVIEW');
  });

  it('allows a close debtor name when EIN corroborates it', () => {
    const result = validate({ documents: [doc({ debtorName: 'Acme Manufactring', debtorEin: '98-7654321', debtorPhone: null })], primaryIndex: 0, debtor, client, today: '2026-09-24' });
    expect(result.checks.find((c) => c.id === 'company-name')?.status).toBe('PASS');
  });

  it('reviews a rate confirmation amount difference', () => {
    const docs = [
      doc(),
      doc({ documentType: 'rate_confirmation', invoiceNumber: null, invoiceDate: null, documentDate: '2026-09-20', invoiceAmount: 12000 }, 'rate-confirmation.pdf'),
    ];
    const result = validate({ documents: docs, primaryIndex: 0, debtor, client, today: '2026-09-24' });
    expect(result.status).toBe('REVIEW');
    expect(result.checks.find((c) => c.id === 'amount-across-docs')?.status).toBe('REVIEW');
  });

  it('does not compare BOL amounts to invoice totals', () => {
    const docs = [
      doc(),
      doc({ documentType: 'bol', invoiceNumber: null, invoiceDate: null, invoiceAmount: 999, debtorName: 'Different Shipper' }, 'bol.pdf'),
    ];
    const result = validate({ documents: docs, primaryIndex: 0, debtor, client, today: '2026-09-24' });
    expect(result.checks.find((c) => c.id === 'amount-across-docs')?.status).toBe('SKIP');
    expect(result.checks.find((c) => c.id === 'debtor-across-docs')?.status).toBe('SKIP');
  });

  it('reviews uncertain extraction', () => {
    const result = validate({ documents: [doc({ uncertainFields: ['invoiceAmount'] })], primaryIndex: 0, debtor, client, today: '2026-09-24' });
    expect(result.status).toBe('REVIEW');
  });

  it('reviews multiple invoice documents', () => {
    const result = validate({ documents: [doc(), doc({}, 'invoice-copy.pdf')], primaryIndex: 0, debtor, client, today: '2026-09-24' });
    expect(result.status).toBe('REVIEW');
    expect(result.checks.find((c) => c.id === 'invoice-document')?.status).toBe('REVIEW');
  });
});
