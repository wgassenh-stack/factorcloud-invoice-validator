import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

import { loadDebtorCredit } from './debtor-credit';

describe('loadDebtorCredit against the documented FactorCloud API', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { FACTORCLOUD_FACTOR_ID: 'f', FACTORCLOUD_BEARER_TOKEN: 't', FACTORCLOUD_API_BASE: 'https://fc.test' });
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  it('reads credit terms and sums what the debtor still owes this client', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      urls.push(url.pathname + url.search);
      if ((init?.headers as Record<string, string>)?.['X-PAGINATION-NUM'] !== '0' && url.pathname === '/invoices') return new Response(JSON.stringify({ invoices: [] }));
      if (url.pathname === '/clients/c1/debtors/d1') {
        return new Response(JSON.stringify({ status: 'SUCCESS', code: 200, clientDebtors: { companyDebtorId: 'd1', companyClientId: 'c1', creditLimit: 10000.0, creditLimitApproved: true, creditRating: 10.0 } }));
      }
      if (url.pathname === '/invoices' && url.searchParams.get('client') === 'c1' && url.searchParams.get('debtor') === 'd1') {
        return new Response(JSON.stringify({ status: 'SUCCESS', code: 200, invoices: [
          { id: 'i1', invoiceNumber: '1', companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 3000, invoiceBalance: 3000, status: 'FUNDED', paymentStatus: 'Open' },
          { id: 'i2', invoiceNumber: '2', companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 2000, invoiceBalance: 0, status: 'PAID', paymentStatus: 'Paid' },
          { id: 'i3', invoiceNumber: '3', companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 1500, invoiceBalance: 1500, status: 'REJECTED' },
        ] }));
      }
      return new Response('{}', { status: 404 });
    }));
    const credit = await loadDebtorCredit('c1', { id: 'd1', companyName: 'Acme', noBuy: false }, 2500);
    expect(urls).toContain('/clients/c1/debtors/d1');
    expect(credit).toMatchObject({ limit: 10000, approved: true, rating: 10, openBalance: 3000, openCount: 1, thisInvoice: 2500, noBuy: false });
    expect(credit.lookupFailed).toBeUndefined();
  });

  it('treats buyStatus=false as no-buy and a missing client-debtor record as no limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/clients/')) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      return new Response(JSON.stringify({ invoices: [] }));
    }));
    const credit = await loadDebtorCredit('c1', { id: 'd2', companyName: 'Titan', buyStatus: false } as never, 100);
    expect(credit).toMatchObject({ noBuy: true, limit: null, openBalance: 0 });
  });

  it('never throws: an unreachable FactorCloud becomes lookupFailed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const credit = await loadDebtorCredit('c1', { id: 'd1', companyName: 'Acme' }, 100);
    expect(credit.lookupFailed).toBe(true);
  });
});
