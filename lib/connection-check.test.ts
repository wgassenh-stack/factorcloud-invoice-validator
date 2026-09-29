import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

import { runConnectionCheck } from './connection-check';

describe('connection check against a fake FactorCloud', () => {
  const saved = { ...process.env };
  const methods: string[] = [];
  beforeEach(() => {
    methods.length = 0;
    Object.assign(process.env, { FACTORCLOUD_FACTOR_ID: 'f', FACTORCLOUD_BEARER_TOKEN: 't', FACTORCLOUD_API_BASE: 'https://fc.test', PORTAL_SIGNING_SECRET: 's', GEMINI_API_KEY: 'g', FACTORCLOUD_DEBTOR_IDS: 'd1,d404' });
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  it('reads each endpoint once, never writes, and reports what is thin', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      methods.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      const page = (init?.headers as Record<string, string>)?.['X-PAGINATION-NUM'];
      if (url.hostname.endsWith('googleapis.com')) return Response.json({ name: 'models/gemini-3.5-flash-lite' });
      if (url.pathname === '/companies/c1') return Response.json({ company: { id: 'c1', companyName: 'Client Co' } });
      if (url.pathname === '/companies/d1') return Response.json({ company: { id: 'd1', companyName: 'Acme' } });
      if (url.pathname === '/invoices') return Response.json({ invoices: page === '0' ? [
        { id: 'i1', invoiceNumber: '1', companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 100, invoiceDate: '2026-09-01', status: 'FUNDED', invoiceBalance: 100, fundedDate: '2026-09-02' },
        { id: 'i2', invoiceNumber: '2', companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 100, invoiceDate: '2026-09-01', status: 'PENDING', verificationStatus: 'NOT_VERIFIED' },
      ] : [] });
      if (url.pathname === '/invoices/i1') return Response.json({ invoice: { id: 'i1' } });
      if (url.pathname === '/clients/c1/debtors/d1') return Response.json({ clientDebtors: { creditLimit: 5000, creditLimitApproved: true } });
      return new Response('{"message":"not found"}', { status: 404 });
    }));

    const report = await runConnectionCheck({ clientId: 'c1', scope: 'client' });
    const state = Object.fromEntries(report.items.map((i) => [i.id, i.state]));
    expect(state).toMatchObject({ settings: 'ok', extraction: 'ok', client: 'ok', invoices: 'ok', 'invoice-detail': 'ok', credit: 'ok', debtors: 'warn', writes: 'skip', coverage: 'warn' });
    expect(report.invoiceCount).toBe(2);
    expect(report.items.find((i) => i.id === 'coverage')!.detail).toContain('Advance amount (0%)');
    expect(methods.every((m) => m.startsWith('GET '))).toBe(true);
    expect(methods.some((m) => m.includes('/models/'))).toBe(true);
  });

  it('turns an unreachable FactorCloud into failed items instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const report = await runConnectionCheck({ clientId: 'c1', scope: 'client' });
    expect(report.items.find((i) => i.id === 'client')!.state).toBe('fail');
    expect(report.items.find((i) => i.id === 'invoices')!.state).toBe('fail');
  });
});
