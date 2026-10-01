import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/portal-auth', () => ({ requireFactorSession: async () => ({ factorId: 'f1', role: 'FACTOR_ADMIN' }) }));
vi.mock('@/lib/demo-request', () => ({ demoRequest: async () => false }));

import { GET } from '../app/api/ops/invoices/[invoiceId]/documents/route';

describe("viewing an invoice's documents from FactorCloud", () => {
  const saved = { ...process.env };
  const pdf = new Uint8Array([37, 80, 68, 70, 45]); // %PDF-
  beforeEach(() => {
    Object.assign(process.env, { FACTORCLOUD_FACTOR_ID: 'f', FACTORCLOUD_BEARER_TOKEN: 't', FACTORCLOUD_API_BASE: 'https://fc.test' });
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === '/invoices/inv-1/combined-documentation') return new Response(JSON.stringify({ status: 'SUCCESS', downloadUrl: 'https://files.fc.test/combined/inv-1.pdf', expires: '2030-01-01' }));
      if (url.pathname === '/invoices/none/combined-documentation') return new Response(JSON.stringify({ message: 'No documents' }), { status: 404 });
      if (url.host === 'files.fc.test') return new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } });
      return new Response('{}', { status: 404 });
    }));
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });
  const call = (id: string, query = '') => GET(new Request(`http://portal.test/api/ops/invoices/${id}/documents${query}`), { params: Promise.resolve({ invoiceId: id }) });

  it('says whether there is anything to show without downloading it', async () => {
    const res = await call('inv-1', '?check=1');
    expect(await res.json()).toEqual({ available: true });
  });

  it('passes the combined PDF through for viewing in the page, not as a download, and never cached', async () => {
    const res = await call('inv-1');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pdf);
  });

  it('an invoice with no documents says so', async () => {
    const res = await call('none', '?check=1');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ available: false, error: expect.stringMatching(/no documents/) });
  });
});
