import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

import { checkCards } from './paperwork';
import type { AnalyzedDocument } from './types';

const doc = (invoiceNumber: string): AnalyzedDocument => ({
  fileName: `${invoiceNumber}.pdf`, fileHash: invoiceNumber, sourceIndex: 0,
  fields: { documentType: 'invoice', invoiceNumber, referenceNumber: null, documentDate: '2026-09-30', clientName: 'Test Trucking', debtorName: 'Acme', debtorAddress: null, debtorCity: null, debtorState: null, debtorZip: null, debtorPhone: null, debtorEmail: null, debtorEin: null, invoiceAmount: 1200, invoiceDate: '2026-09-30', dueDate: null, signaturePresent: null, uncertainFields: [], notes: null },
} as unknown as AnalyzedDocument);

describe('duplicate warning when the paperwork is read', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { FACTORCLOUD_FACTOR_ID: 'f', FACTORCLOUD_BEARER_TOKEN: 't', FACTORCLOUD_API_BASE: 'https://fc.test', FACTORCLOUD_DEBTOR_IDS: 'd1', PORTAL_SIGNING_SECRET: 'signing-secret-for-tests' });
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.pathname.startsWith('/companies/')) return ok({ data: { id: url.pathname.split('/')[2], companyName: 'Acme' } });
      if (url.pathname === '/invoices') {
        // FactorCloud already has INV-100 for this client (and an INV-300 for another client).
        const all = [
          { id: 'fc-100', invoiceNumber: 'INV-100', companyClientId: 'c1', status: 'FUNDED' },
          { id: 'fc-300', invoiceNumber: 'INV-300', companyClientId: 'someone-else', status: 'PENDING' },
        ];
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        return ok({ invoices: all.filter((i) => i.invoiceNumber.toLowerCase().replace(/[^a-z0-9]/g, '').includes(q.replace(/[^a-z0-9]/g, ''))) });
      }
      return new Response('{}', { status: 404 });
    }));
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  it('flags an invoice number FactorCloud already has for this client, however it is written', async () => {
    const documents = [doc('inv 100'), doc('INV-200'), doc('INV-300')];
    const { cards } = await checkCards('c1', documents, documents.map((_, i) => ({ id: `card-${i}`, documentIndexes: [i] })));
    expect(cards[0].existing).toMatchObject({ invoiceId: 'fc-100', status: 'FUNDED' });
    expect(cards[1].existing).toBeUndefined();
    // Another client's invoice with the same number is not a duplicate.
    expect(cards[2].existing).toBeUndefined();
  });

  it('warns when two invoices in one upload share a number', async () => {
    const documents = [doc('INV-500'), doc('inv500')];
    const { cards } = await checkCards('c1', documents, documents.map((_, i) => ({ id: `card-${i}`, documentIndexes: [i] })));
    expect(cards[0].warnings.join(' ')).not.toMatch(/Same invoice number/);
    expect(cards[1].warnings.join(' ')).toMatch(/Same invoice number as another invoice in this upload/);
  });
});
