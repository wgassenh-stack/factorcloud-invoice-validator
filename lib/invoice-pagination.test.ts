import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

import { duplicateSearchTerms, findExistingInvoice, listInvoices, MAX_INVOICE_PAGES } from './factorcloud';

type Invoice = { id: string; invoiceNumber: string; companyClientId: string };

/** A fake FactorCloud GET /invoices honoring the documented pagination headers and filters. */
function fakeFactorCloud(all: Invoice[], opts: { maxLimit?: number; ignorePaging?: boolean; rejectLimitAbove?: number } = {}) {
  const calls: { page: number; limit: number; client: string | null; q: string | null }[] = [];
  const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string>;
    const page = Number(headers['X-PAGINATION-NUM'] ?? 0);
    let limit = Number(headers['X-PAGINATION-LIMIT'] ?? 20);
    calls.push({ page, limit, client: url.searchParams.get('client'), q: url.searchParams.get('q') });
    if (opts.rejectLimitAbove && limit > opts.rejectLimitAbove) {
      return new Response(JSON.stringify({ status: 'ERROR', message: 'limit too large' }), { status: 400 });
    }
    if (opts.maxLimit) limit = Math.min(limit, opts.maxLimit);
    let rows = all;
    const client = url.searchParams.get('client');
    const q = url.searchParams.get('q');
    if (client) rows = rows.filter((r) => r.companyClientId === client);
    if (q) rows = rows.filter((r) => r.invoiceNumber.toLowerCase().includes(q.toLowerCase()));
    const slice = opts.ignorePaging ? rows.slice(0, limit) : rows.slice(page * limit, page * limit + limit);
    return new Response(JSON.stringify({ status: 'SUCCESS', code: 200, invoices: slice }), { status: 200 });
  });
  return { fetchMock, calls };
}

const invoices = (n: number, client = 'c1'): Invoice[] =>
  Array.from({ length: n }, (_, i) => ({ id: `inv-${client}-${i}`, invoiceNumber: `INV-${1000 + i}`, companyClientId: client }));

const ids = (raw: unknown[]) => raw.flatMap((page) => (page as { invoices: Invoice[] }).invoices.map((i) => i.id));

describe('listInvoices pagination', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.FACTORCLOUD_FACTOR_ID = 'factor-1';
    process.env.FACTORCLOUD_BEARER_TOKEN = 'token';
    process.env.FACTORCLOUD_API_BASE = 'https://fc.test';
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  it('reads every page and stops at the short last page', async () => {
    const { fetchMock, calls } = fakeFactorCloud(invoices(250));
    vi.stubGlobal('fetch', fetchMock);
    const result = await listInvoices();
    expect(result.complete).toBe(true);
    expect(new Set(ids(result.raw)).size).toBe(250);
    expect(calls.map((c) => c.page)).toEqual([0, 1, 2]); // 100 + 100 + 50: short page after full ones ends it
    expect(calls[0].limit).toBe(100);
  });

  it('sends the documented headers and the client/q filters', async () => {
    const { fetchMock } = fakeFactorCloud([...invoices(5, 'c1'), ...invoices(5, 'c2')]);
    vi.stubGlobal('fetch', fetchMock);
    const result = await listInvoices({ client: 'c2', q: 'INV-100' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('client=c2');
    expect(String(url)).toContain('q=INV-100');
    expect((init!.headers as Record<string, string>)['X-PAGINATION-NUM']).toBe('0');
    expect(ids(result.raw).every((id) => id.startsWith('inv-c2'))).toBe(true);
  });

  it('confirms the end with an empty page when a short first page could be a silent size cap', async () => {
    const { fetchMock, calls } = fakeFactorCloud(invoices(120), { maxLimit: 50 });
    vi.stubGlobal('fetch', fetchMock);
    const result = await listInvoices();
    expect(result.complete).toBe(true);
    expect(new Set(ids(result.raw)).size).toBe(120); // would have stopped at 50 if a short page meant "done"
    expect(calls.length).toBe(4); // 50, 50, 20, then empty
  });

  it('treats an empty first page as a complete, empty list', async () => {
    const { fetchMock } = fakeFactorCloud([]);
    vi.stubGlobal('fetch', fetchMock);
    expect(await listInvoices()).toMatchObject({ complete: true, raw: [], pages: 1 });
  });

  it('reports incomplete when FactorCloud ignores the page header', async () => {
    const { fetchMock } = fakeFactorCloud(invoices(150), { ignorePaging: true });
    vi.stubGlobal('fetch', fetchMock);
    const result = await listInvoices();
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/pagination was not applied/);
    expect(new Set(ids(result.raw)).size).toBe(100);
  });

  it('falls back to the default page size when FactorCloud rejects a large one', async () => {
    const { fetchMock, calls } = fakeFactorCloud(invoices(45), { rejectLimitAbove: 20 });
    vi.stubGlobal('fetch', fetchMock);
    const result = await listInvoices();
    expect(result.complete).toBe(true);
    expect(new Set(ids(result.raw)).size).toBe(45);
    expect(calls[0].limit).toBe(100);
    expect(calls.slice(1).every((c) => c.limit === 20)).toBe(true);
  });

  it('stops at the page cap and says so', async () => {
    const { fetchMock } = fakeFactorCloud(invoices(MAX_INVOICE_PAGES * 100 + 5));
    vi.stubGlobal('fetch', fetchMock);
    const result = await listInvoices();
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toMatch(/Stopped after/);
  });
});

describe('duplicate check', () => {
  beforeEach(() => {
    process.env.FACTORCLOUD_FACTOR_ID = 'factor-1';
    process.env.FACTORCLOUD_BEARER_TOKEN = 'token';
    process.env.FACTORCLOUD_API_BASE = 'https://fc.test';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('searches the raw number, its normalized form and its longest digit run', () => {
    expect(duplicateSearchTerms('INV-001234')).toEqual(['INV-001234', 'INV001234', '001234']);
    expect(duplicateSearchTerms('ABC')).toEqual(['ABC']);
  });

  it('finds a duplicate beyond the first page, ignoring punctuation, only for this client', async () => {
    const all = [...invoices(300, 'c1'), { id: 'dup', invoiceNumber: 'INV-77777', companyClientId: 'c1' }, { id: 'other', invoiceNumber: 'INV77777', companyClientId: 'c2' }];
    const { fetchMock } = fakeFactorCloud(all);
    vi.stubGlobal('fetch', fetchMock);
    const found = await findExistingInvoice('c1', 'inv77777');
    expect(found).toEqual({ existing: { id: 'dup', status: null }, complete: true });
    const none = await findExistingInvoice('c1', 'INV-99999');
    expect(none).toEqual({ existing: null, complete: true });
  });

  it('reports an incomplete check when pages cannot be read to the end', async () => {
    // 150 invoices match the search "ABC-12" but none is exactly ABC-12, and paging is ignored.
    const { fetchMock } = fakeFactorCloud(invoices(150).map((i, n) => ({ ...i, invoiceNumber: `ABC-12${n}` })), { ignorePaging: true });
    vi.stubGlobal('fetch', fetchMock);
    const result = await findExistingInvoice('c1', 'ABC-12');
    expect(result).toEqual({ existing: null, complete: false });
  });
});
