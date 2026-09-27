import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { ReceiptError, signAnalysisReceipt, signDocumentsReceipt, verifyAnalysisReceipt, verifyDocumentsReceipt } from './submission-integrity';
import type { AnalyzedDocument } from './types';

const docs = [{ fileName: 'invoice.pdf', fileHash: 'abc', sourceIndex: 0, fields: { documentType: 'invoice' } }] as unknown as AnalyzedDocument[];

describe('upload (documents) receipts', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env.PORTAL_SIGNING_SECRET = 'receipt-secret-for-tests'; });
  afterEach(() => { process.env = { ...saved }; });

  it('round-trips what was read', () => {
    const out = verifyDocumentsReceipt(signDocumentsReceipt('client-1', docs));
    expect(out).toMatchObject({ kind: 'documents', clientId: 'client-1', documents: docs });
  });

  it('rejects any change to what was read', () => {
    const [encoded, signature] = signDocumentsReceipt('client-1', docs).split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    payload.documents[0].fields.invoiceAmount = 99999;
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
    expect(() => verifyDocumentsReceipt(forged)).toThrow(ReceiptError);
  });

  it('never passes as an invoice receipt, or the other way round', () => {
    const upload = signDocumentsReceipt('client-1', docs);
    expect(() => verifyAnalysisReceipt(upload)).toThrow(ReceiptError);
    const invoice = signAnalysisReceipt({ version: 1, clientId: 'client-1', debtorId: 'd1', primaryIndex: 0, documents: docs });
    expect(() => verifyDocumentsReceipt(invoice)).toThrow(ReceiptError);
  });

  it('expires after a day', () => {
    const old = signDocumentsReceipt('client-1', docs, Date.now() - 25 * 60 * 60 * 1000);
    expect(() => verifyDocumentsReceipt(old)).toThrow(/expired/);
  });
});
