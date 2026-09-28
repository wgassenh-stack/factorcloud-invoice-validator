// The send step end to end against a stand-in FactorCloud (shared-password mode, no database):
// an invoice sent anyway with a failed check is created with the full review note and gets the
// factor's review label; a clean one gets neither.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

const CLIENT = 'fc-client-1';
const DEBTOR = 'fc-debtor-1';

describe('sending an invoice (stand-in FactorCloud)', () => {
  const saved = { ...process.env };
  const calls: { method: string; url: string; body: unknown }[] = [];

  beforeAll(() => {
    Object.assign(process.env, {
      PORTAL_AUTH_MODE: 'pilot', PORTAL_SIGNING_SECRET: 'sig-secret-for-tests', FACTORCLOUD_FACTOR_ID: 'f', FACTORCLOUD_CLIENT_ID: CLIENT,
      FACTORCLOUD_DEBTOR_IDS: DEBTOR, FACTORCLOUD_BEARER_TOKEN: 't', FACTORCLOUD_API_BASE: 'https://fc.test',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/companies/')) {
        const id = url.split('/companies/')[1].split('?')[0];
        return ok({ data: { id, companyName: id === CLIENT ? 'Test Trucking LLC' : 'Acme Manufacturing LLC', address1: '1 Main St', city: 'Dallas', stateCode: 'TX', zipCode: '75205', phone: '3343770535', noBuy: false } });
      }
      if (url.startsWith('https://fc.test/labels')) return ok([{ id: 'l-oos', name: 'OOS' }, { id: 'l-review', name: 'Portal review.' }]);
      if (url.startsWith('https://fc.test/invoices?')) return ok({ invoices: [] });
      if (url.startsWith('https://fc.test/clients/')) return ok({});
      if (url === 'https://fc.test/invoices' && method === 'POST') return ok({ data: { id: `inv-${calls.length}` } }, 201);
      if (url.startsWith('https://fc.test/documents')) return ok({ data: { id: `doc-${calls.length}` } });
      return ok({ status: 'SUCCESS' });
    }));
  });

  async function send(invoiceNumber: string, fields: Record<string, unknown>, explanation: string | null) {
    const { signAnalysisReceipt, hashFile } = await import('./submission-integrity');
    const file = new File([`pdf ${invoiceNumber}`], `${invoiceNumber}.pdf`, { type: 'application/pdf' });
    const document = {
      fileName: file.name, fileHash: await hashFile(file), sourceIndex: 0,
      fields: {
        documentType: 'invoice', invoiceNumber, referenceNumber: 'LD1', documentDate: '2026-09-27', clientName: 'Test Trucking LLC',
        debtorName: 'Acme Manufacturing LLC', debtorAddress: '1 Main St', debtorCity: 'Dallas', debtorState: 'TX', debtorZip: '75205', debtorPhone: '3343770535',
        debtorEmail: null, debtorEin: null, invoiceAmount: 1000, invoiceDate: '2026-09-27', dueDate: null, signaturePresent: null, uncertainFields: [], notes: null, ...fields,
      },
    };
    const receipt = signAnalysisReceipt({ version: 1, clientId: CLIENT, debtorId: DEBTOR, primaryIndex: 0, documents: [document] } as never);
    const form = new FormData();
    form.append('payload', JSON.stringify({ invoiceNumber, referenceNumber: 'LD1', invoiceAmount: 1000, invoiceDate: '2026-09-27', debtorId: DEBTOR, analysisReceipt: receipt, explanation }));
    form.append('files', file);
    const before = calls.length;
    const { POST } = await import('../app/api/create/route');
    const res = await POST(new Request('http://portal.test/api/create', { method: 'POST', body: form }));
    return { status: res.status, body: await res.json(), calls: calls.slice(before) };
  }

  it('a flagged invoice sent anyway gets the review note and the review label', async () => {
    // The invoice says a different amount than the one sent: a failed check the client explains.
    const out = await send('FCB-9001', { invoiceAmount: 1100 }, 'Lumper fee was taken off at delivery.');
    expect(out.status).toBe(200);
    const created = out.calls.find((c) => c.method === 'POST' && c.url === 'https://fc.test/invoices')!;
    const notes = (created.body as { notes: string }).notes;
    expect(notes).toContain('PORTAL REVIEW REQUIRED');
    expect(notes).toContain('Client note: Lumper fee was taken off at delivery.');
    const label = out.calls.find((c) => c.method === 'PATCH');
    expect(label?.url).toMatch(/\/invoices\/inv-\d+\/labels$/);
    expect(label?.body).toEqual({ labelIds: ['l-review'] });
  });

  it('a clean invoice gets neither', async () => {
    const out = await send('FCB-9002', {}, null);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const created = out.calls.find((c) => c.method === 'POST' && c.url === 'https://fc.test/invoices')!;
    expect((created.body as { notes: string }).notes).not.toContain('PORTAL REVIEW REQUIRED');
    expect(out.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  afterAll(() => { vi.unstubAllGlobals(); process.env = saved; });
});
