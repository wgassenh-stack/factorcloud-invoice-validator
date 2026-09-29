// The funding engine end to end: invoices sent through the real send step, a stand-in FactorCloud,
// and a real PostgreSQL database. Covers each lane: auto-funded, approved and held for a click (then
// funded by the click), over a cap, suggest only, and paperwork review. TRUNCATEs portal tables, so it
// only runs with TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let sessionCookie = '';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (name === 'fc_portal_session' && sessionCookie ? { value: sessionCookie } : undefined) }) }));

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const CLIENT = 'fc-client-1';
const DEBTOR = 'fc-debtor-1';
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

describe.skipIf(!enabled)('funding engine (real SQL, stand-in FactorCloud)', () => {
  const saved = { ...process.env };
  let query: typeof import('./db').query;
  let pool: typeof import('./db').pool;
  const calls: { method: string; path: string; body: any }[] = [];
  const fc = {
    creditLimit: 50_000,
    cashReserve: 1500,
    invoices: [] as Record<string, unknown>[],
    groupSeq: 0,
  };
  const admin = { v: 1 as const, userId: 's1', email: 'admin@x.com', displayName: 'Factor Admin', role: 'FACTOR_ADMIN' as const, factorId: 'f1', clients: [], exp: Date.now() + 3600_000 };

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: process.env.TEST_DATABASE_URL, PORTAL_AUTH_MODE: 'database', AUTH_SESSION_SECRET: 'session-secret-for-integration',
      PORTAL_SIGNING_SECRET: 'signing-secret-for-tests', FACTORCLOUD_FACTOR_ID: 'fc-factor-1', FACTORCLOUD_CLIENT_ID: CLIENT, FACTORCLOUD_DEBTOR_IDS: DEBTOR,
      FACTORCLOUD_BEARER_TOKEN: 'token', FACTORCLOUD_API_BASE: 'https://fc.test',
    });
    // Three months of paid history across several debtors, so the client-level rules have something to go on.
    for (let i = 0; i < 12; i++) fc.invoices.push({ id: `old-${i}`, invoiceNumber: `OLD-${i}`, companyClientId: CLIENT, companyDebtorId: i % 3 ? `d-other-${i % 3}` : DEBTOR, invoiceAmount: 1000, invoiceBalance: 0, invoiceDate: iso(40 + i * 6), createdOn: iso(40 + i * 6), status: 'PAID', paidDate: iso(20), paymentStatus: 'PAID' });

    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, path: url.pathname, body });
      const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      const p = url.pathname;
      if (p.startsWith('/companies/') && p.endsWith('/funding-instruction')) return ok({ paymentInformationList: [{ id: 'fi-1', name: 'Operating account', paymentMethod: 'ACH', default: true }] });
      if (p.startsWith('/companies/')) {
        const id = p.split('/')[2];
        return ok({ data: { id, companyName: id === CLIENT ? 'Test Trucking LLC' : 'Acme Manufacturing LLC', address1: '1 Main St', city: 'Dallas', stateCode: 'TX', zipCode: '75205', phone: '3343770535', noBuy: false } });
      }
      if (p === `/clients/${CLIENT}/debtors/${DEBTOR}`) return ok({ clientDebtors: { creditLimit: fc.creditLimit, creditLimitApproved: true, creditRating: 80 } });
      if (p === `/clients/${CLIENT}`) return ok({ client: { id: CLIENT, creditLimit: null } });
      if (p === '/ledgers/cash-reserve') return ok({ ledgers: [{ increaseAmount: fc.cashReserve, decreaseAmount: 0 }] });
      if (p === '/labels') return ok([{ id: 'l-review', name: 'Portal review.' }]);
      if (p === '/invoices' && method === 'GET') {
        const page = Number((init?.headers as Record<string, string>)?.['X-PAGINATION-NUM'] ?? 0);
        const client = url.searchParams.get('client'); const debtor = url.searchParams.get('debtor');
        const rows = fc.invoices.filter((r) => (!client || r.companyClientId === client) && (!debtor || r.companyDebtorId === debtor));
        return ok({ invoices: page === 0 ? rows : [] });
      }
      if (p === '/invoices' && method === 'POST') {
        const id = `inv-${fc.invoices.length + 1}`;
        fc.invoices.push({ ...body, id, invoiceBalance: body.invoiceAmount, status: 'PENDING', createdOn: new Date().toISOString() });
        return ok({ data: { id } }, 201);
      }
      if (p === '/invoices/approve-for-funding') return ok({ status: 'SUCCESS', invoiceGroups: [{ id: `g-${++fc.groupSeq}`, code: `G${fc.groupSeq}`, status: 'NOT_FUNDED', paymentType: 'ACH', paymentAmount: 900 }] });
      if (p.startsWith('/documents')) return ok({ data: { id: `doc-${calls.length}` } });
      return ok({ status: 'SUCCESS' });
    }));

    ({ query, pool } = await import('./db'));
    await query('drop table if exists engine_runs');
    await query('drop table if exists rule_settings');
    await query('drop table if exists client_tasks');
    await query('truncate audit_events, review_items, submission_files, submissions, user_client_access, portal_users, portal_clients, factors cascade');
    await query(`insert into factors (id, factorcloud_factor_id, name) values ('f1','fc-factor-1','F')`);
    await query(`insert into portal_clients (id, factor_id, factorcloud_client_id, name) values ('pc1','f1','${CLIENT}','Test Trucking LLC')`);
    await query(`insert into portal_users (id, factor_id, email, role) values ('s1','f1','admin@x.com','FACTOR_ADMIN')`);
    sessionCookie = await (await import('./session')).signPortalSession(admin);
  });

  async function setRules(change: (s: any) => void) {
    const { GET, PUT } = await import('../app/api/ops/rules/route');
    const { settings } = await (await GET()).json();
    change(settings);
    const res = await PUT(new Request('http://portal.test/api/ops/rules', { method: 'PUT', body: JSON.stringify({ settings }) }));
    expect(res.status).toBe(200);
  }

  async function send(invoiceNumber: string, amount: number, opts: { documentAmount?: number; explanation?: string } = {}) {
    const { signAnalysisReceipt, hashFile } = await import('./submission-integrity');
    const file = new File([`pdf ${invoiceNumber}`], `${invoiceNumber}.pdf`, { type: 'application/pdf' });
    const fields = {
      documentType: 'invoice', invoiceNumber, referenceNumber: `LD-${invoiceNumber}`, documentDate: new Date().toISOString().slice(0, 10), clientName: 'Test Trucking LLC',
      debtorName: 'Acme Manufacturing LLC', debtorAddress: '1 Main St', debtorCity: 'Dallas', debtorState: 'TX', debtorZip: '75205', debtorPhone: '3343770535',
      debtorEmail: null, debtorEin: null, invoiceAmount: opts.documentAmount ?? amount, invoiceDate: new Date().toISOString().slice(0, 10), dueDate: null, signaturePresent: null, uncertainFields: [], notes: null,
    };
    const receipt = signAnalysisReceipt({ version: 1, clientId: CLIENT, debtorId: DEBTOR, primaryIndex: 0, documents: [{ fileName: file.name, fileHash: await hashFile(file), sourceIndex: 0, fields }] } as never);
    const form = new FormData();
    form.append('payload', JSON.stringify({ invoiceNumber, referenceNumber: `LD-${invoiceNumber}`, invoiceAmount: amount, invoiceDate: fields.invoiceDate, debtorId: DEBTOR, analysisReceipt: receipt, explanation: opts.explanation ?? null }));
    form.append('files', file);
    const before = calls.length;
    const { POST } = await import('../app/api/create/route');
    const res = await POST(new Request('http://portal.test/api/create', { method: 'POST', body: form }));
    const out = await res.json();
    expect(res.status, JSON.stringify(out)).toBe(200);
    const { listRuns } = await import('./funding-engine');
    const run = (await listRuns('f1')).find((r) => r.factorCloudInvoiceId === out.invoiceId)!;
    return { run, writes: calls.slice(before).filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`) };
  }

  it('all good: verified, approved and funded with no one clicking', async () => {
    // A small test client: one debtor's share and a short history are expected here.
    await setRules((s) => { s.mode = 'fund'; s.rules.concentration.enabled = false; s.rules.newClient.enabled = false; });
    const { run, writes } = await send('AUTO-1', 1000);
    expect(run).toMatchObject({ outcome: 'FUND', state: 'FUNDED', autoFunded: true, reasons: [] });
    expect(writes).toEqual(expect.arrayContaining(['PATCH /invoices/verification', 'PATCH /invoices/approve-for-funding', 'PATCH /invoice-groups/fund']));
    const fund = calls.find((c) => c.path === '/invoice-groups/fund')!;
    expect(fund.body).toMatchObject({ action: 'fund', invoiceGroups: [run.invoiceGroupId], paymentType: 'ACH', transactionId: `portal-fund-${run.invoiceGroupId}` });
  });

  it('clean invoice over the credit limit: approved, held for a click, then funded by the click', async () => {
    fc.creditLimit = 1500;
    const { run, writes } = await send('HOLD-1', 1200);
    expect(run).toMatchObject({ outcome: 'HOLD', state: 'APPROVED' });
    expect(run.reasons[0]).toMatch(/Over the credit limit/);
    expect(writes).toContain('PATCH /invoices/approve-for-funding');
    expect(writes).not.toContain('PATCH /invoice-groups/fund');
    // The credit limit is the engine's call: no review item for a clean invoice.
    const reviews = await query('select 1 from review_items r join submissions s on s.id = r.submission_id where s.factorcloud_invoice_id = $1', [run.factorCloudInvoiceId]);
    expect(reviews).toHaveLength(0);

    const { POST } = await import('../app/api/ops/funding/[runId]/route');
    const click = () => POST(new Request('http://portal.test/x', { method: 'POST', body: JSON.stringify({ action: 'fund' }) }), { params: Promise.resolve({ runId: run.id }) });
    const first = await click();
    expect(first.status).toBe(200);
    expect((await first.json()).run).toMatchObject({ state: 'FUNDED', autoFunded: false });
    // A second click can't fund twice.
    const second = await click();
    expect(second.status).toBe(409);
    expect(calls.filter((c) => c.path === '/invoice-groups/fund' && c.body.invoiceGroups[0] === run.invoiceGroupId)).toHaveLength(1);
    fc.creditLimit = 50_000;
  });

  it('over the per-invoice cap: approved, not funded', async () => {
    const { run } = await send('BIG-1', 6000);
    expect(run).toMatchObject({ outcome: 'HOLD', state: 'APPROVED' });
    expect(run.reasons.join(' ')).toMatch(/over the \$5,000 auto-funding cap/);
  });

  it('negative cash reserve: held', async () => {
    fc.cashReserve = -200;
    const { run } = await send('RES-1', 500);
    expect(run).toMatchObject({ outcome: 'HOLD', state: 'APPROVED' });
    expect(run.reasons.join(' ')).toMatch(/Cash reserve is negative/);
    fc.cashReserve = 1500;
  });

  it('paperwork sent anyway: review queue, nothing approved', async () => {
    const { run, writes } = await send('REV-1', 900, { documentAmount: 950, explanation: 'Lumper fee taken off at delivery.' });
    expect(run).toMatchObject({ outcome: 'REVIEW', state: 'REVIEW' });
    expect(writes).not.toContain('PATCH /invoices/approve-for-funding');
  });

  it('suggest only: nothing done in FactorCloud until a person approves', async () => {
    await setRules((s) => { s.mode = 'suggest'; });
    const { run, writes } = await send('SUG-1', 800);
    expect(run).toMatchObject({ outcome: 'FUND', state: 'SUGGESTED' });
    expect(writes.filter((w) => /verification|approve-for-funding|invoice-groups/.test(w))).toEqual([]);
    const { POST } = await import('../app/api/ops/funding/[runId]/route');
    const res = await POST(new Request('http://portal.test/x', { method: 'POST', body: JSON.stringify({ action: 'approve' }) }), { params: Promise.resolve({ runId: run.id }) });
    expect((await res.json()).run).toMatchObject({ state: 'APPROVED' });
  });

  it('only a factor admin may change the rules or fund', async () => {
    const reviewer = { ...admin, userId: 's2', email: 'rev@x.com', role: 'FACTOR_REVIEWER' as const };
    await query(`insert into portal_users (id, factor_id, email, role) values ('s2','f1','rev@x.com','FACTOR_REVIEWER') on conflict do nothing`);
    sessionCookie = await (await import('./session')).signPortalSession(reviewer);
    const { PUT } = await import('../app/api/ops/rules/route');
    expect((await PUT(new Request('http://portal.test/x', { method: 'PUT', body: JSON.stringify({ settings: { mode: 'fund' } }) }))).status).toBe(403);
    sessionCookie = await (await import('./session')).signPortalSession(admin);
  });

  afterAll(async () => {
    await pool?.().end();
    vi.unstubAllGlobals();
    process.env = saved;
  });
});
