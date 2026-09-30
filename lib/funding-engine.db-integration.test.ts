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
    refuseApprove: false,
    // FactorCloud batches like the real thing: one open (NOT_FUNDED) batch per client; approving adds to it.
    groups: [] as { id: string; code: string; clientId: string; status: string; invoiceIds: string[] }[],
    listUnrelatedBatchFirst: false,
    timeoutApprove: false,
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
      if (p.startsWith('/invoices/') && p.split('/').length === 3 && method === 'GET') {
        const invoice = fc.invoices.find((r) => r.id === p.split('/')[2]);
        return invoice ? ok({ status: 'SUCCESS', invoice }) : ok({ error: 'not found' }, 404);
      }
      if (p === '/invoices/approve-for-funding' && fc.timeoutApprove) throw Error('response lost');
      if (p === '/invoices/approve-for-funding' && fc.refuseApprove) return ok({ message: 'final OpenAR calculated 36,000 exceeds the credit limit 25,000' }, 400);
      const groupJson = (g: (typeof fc.groups)[number]) => ({ id: g.id, code: g.code, companyClientId: g.clientId, status: g.status, paymentType: 'ACH', paymentAmount: 900, nInvoices: g.invoiceIds.length });
      if (p === '/invoices/approve-for-funding') {
        for (const r of fc.invoices) if (body.invoiceIds.includes(r.id)) r.status = 'APPROVED';
        let group = fc.groups.find((g) => g.clientId === body.companyClientId && g.status === 'NOT_FUNDED');
        if (!group) { group = { id: `g-${++fc.groupSeq}`, code: `G${fc.groupSeq}`, clientId: body.companyClientId, status: 'NOT_FUNDED', invoiceIds: [] }; fc.groups.push(group); }
        group.invoiceIds.push(...body.invoiceIds);
        const unrelated = { id: 'g-unrelated', code: 'OTHER', clientId: 'someone-else', status: 'NOT_FUNDED', invoiceIds: ['x'] };
        return ok({ status: 'SUCCESS', invoiceGroups: fc.listUnrelatedBatchFirst ? [groupJson(unrelated), groupJson(group)] : [groupJson(group)] });
      }
      if (p === '/invoice-groups/fund') {
        const targets = fc.groups.filter((g) => body.invoiceGroups.includes(g.id));
        if (!targets.length || targets.some((g) => g.status !== 'NOT_FUNDED')) return ok({ message: 'Invoice group already funded' }, 400);
        for (const g of targets) { g.status = 'FUNDED'; for (const r of fc.invoices) if (g.invoiceIds.includes(String(r.id))) r.status = 'FUNDED'; }
        return ok({ status: 'SUCCESS' });
      }
      if (/^\/invoices\/[^/]+\/invoice-funding$/.test(p)) {
        const id = p.split('/')[2];
        return ok({ status: 'SUCCESS', invoiceFundings: fc.groups.filter((g) => g.invoiceIds.includes(id)).map((g, n) => ({ id: `f-${g.id}-${id}`, invoiceId: id, invoiceGroupId: g.id, createdOn: new Date(Date.now() + n).toISOString() })) });
      }
      if (/^\/invoice-groups\/[^/]+\/invoice-funding$/.test(p)) {
        const g = fc.groups.find((x) => x.id === p.split('/')[2]);
        const page = Number((init?.headers as Record<string, string>)?.['X-PAGINATION-NUM'] ?? 0);
        return g ? ok({ status: 'SUCCESS', invoiceFundings: page === 0 ? g.invoiceIds.map((id) => ({ invoiceId: id, invoiceGroupId: g.id })) : [] }) : ok({ error: 'not found' }, 404);
      }
      if (/^\/invoice-groups\/[^/]+$/.test(p) && method === 'GET') {
        const g = fc.groups.find((x) => x.id === p.split('/')[2]);
        return g ? ok({ status: 'SUCCESS', invoiceGroup: groupJson(g) }) : ok({ error: 'not found' }, 404);
      }
      if (p.startsWith('/documents')) return ok({ data: { id: `doc-${calls.length}` } });
      return ok({ status: 'SUCCESS' });
    }));

    ({ query, pool } = await import('./db'));
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
    await setRules((s) => { s.mode = 'fund'; s.rules.concentration.enabled = false; s.rules.newClient.enabled = false; s.caps.perClientPerDay = 100_000; s.caps.perFactorPerDay = 200_000; });
    const { run, writes } = await send('AUTO-1', 1000);
    expect(run).toMatchObject({ outcome: 'FUND', state: 'FUNDED', autoFunded: true, reasons: [] });
    expect(writes).toEqual(expect.arrayContaining(['PATCH /invoices/verification', 'PATCH /invoices/approve-for-funding', 'PATCH /invoice-groups/fund']));
    const fund = calls.find((c) => c.path === '/invoice-groups/fund')!;
    expect(fund.body).toMatchObject({ action: 'fund', invoiceGroups: [run.invoiceGroupId], paymentType: 'ACH', transactionId: `portal-fund-${run.invoiceGroupId}` });
  });

  it('clean invoice over the credit limit: held for one click (not approved in FactorCloud), then approved and funded by the click', async () => {
    fc.creditLimit = 1500;
    const { run, writes } = await send('HOLD-1', 1200);
    expect(run).toMatchObject({ outcome: 'HOLD', state: 'SUGGESTED', mode: 'fund' });
    expect(run.reasons[0]).toMatch(/Over the credit limit/);
    // Not approved yet, so it can't land in another invoice's funding batch.
    expect(writes).not.toContain('PATCH /invoices/approve-for-funding');
    expect(writes).not.toContain('PATCH /invoice-groups/fund');
    // The credit limit is the engine's call: no review item for a clean invoice.
    const reviews = await query('select 1 from review_items r join submissions s on s.id = r.submission_id where s.factorcloud_invoice_id = $1', [run.factorCloudInvoiceId]);
    expect(reviews).toHaveLength(0);

    const { POST } = await import('../app/api/ops/funding/[runId]/route');
    const click = () => POST(new Request('http://portal.test/x', { method: 'POST', body: JSON.stringify({ action: 'fund' }) }), { params: Promise.resolve({ runId: run.id }) });
    const first = await click();
    const out = await first.json();
    expect(first.status, JSON.stringify(out)).toBe(200);
    expect(out.run).toMatchObject({ state: 'FUNDED', autoFunded: false });
    // A second click can't fund twice.
    const second = await click();
    expect(second.status).toBe(409);
    expect(calls.filter((c) => c.path === '/invoice-groups/fund' && c.body.invoiceGroups[0] === out.run.invoiceGroupId)).toHaveLength(1);
    fc.creditLimit = 50_000;
  });

  it('mixed invoices for one client: the held one is not swept into the clean one\'s funding, and the clean one still auto-funds', async () => {
    const held = await send('MIX-HELD', 6000); // over the $5,000 cap
    expect(held.run).toMatchObject({ outcome: 'HOLD', state: 'SUGGESTED' });
    fc.listUnrelatedBatchFirst = true; // FactorCloud lists another batch first: use the one the invoice is really in
    const clean = await send('MIX-CLEAN', 800);
    fc.listUnrelatedBatchFirst = false;
    expect(clean.run).toMatchObject({ outcome: 'FUND', state: 'FUNDED', autoFunded: true });
    expect(clean.run.invoiceGroupId).not.toBe('g-unrelated');
    const funded = fc.groups.find((g) => g.id === clean.run.invoiceGroupId)!;
    expect(funded.invoiceIds).toEqual([clean.run.factorCloudInvoiceId]);
    expect(fc.invoices.find((r) => r.id === held.run.factorCloudInvoiceId)?.status).toBe('PENDING');
    const { listRuns } = await import('./funding-engine');
    expect((await listRuns('f1', { id: held.run.id }))[0]).toMatchObject({ state: 'SUGGESTED', autoFunded: false });
    fc.invoices = fc.invoices.filter((r) => !['MIX-HELD', 'MIX-CLEAN'].includes(String(r.invoiceNumber)));
    await query("update engine_runs set state='REVIEW' where id=$1", [held.run.id]);
  });

  it('an invoice approved by hand in FactorCloud shares the open batch: auto-fund waits and says why; the click shows and funds the whole batch', async () => {
    fc.invoices.push({ id: 'outside-1', invoiceNumber: 'HAND-1', companyClientId: CLIENT, companyDebtorId: 'd-other-1', invoiceAmount: 300, invoiceBalance: 300, invoiceDate: iso(1), createdOn: iso(1), status: 'APPROVED' });
    fc.groups.push({ id: 'g-hand', code: 'HAND', clientId: CLIENT, status: 'NOT_FUNDED', invoiceIds: ['outside-1'] });
    const { run } = await send('WITH-HAND', 700);
    expect(run).toMatchObject({ outcome: 'FUND', state: 'APPROVED', invoiceGroupId: 'g-hand' });
    expect(run.detail).toMatch(/batch HAND with HAND-1/);
    expect(calls.filter((c) => c.path === '/invoice-groups/fund' && c.body.invoiceGroups[0] === 'g-hand')).toHaveLength(0);

    const { GET, POST } = await import('../app/api/ops/funding/[runId]/route');
    const preview = await (await GET(new Request('http://portal.test/x'), { params: Promise.resolve({ runId: run.id }) })).json();
    expect(preview.batch.invoices.map((i: { invoiceNumber: string }) => i.invoiceNumber).sort()).toEqual(['HAND-1', 'WITH-HAND']);
    const res = await POST(new Request('http://portal.test/x', { method: 'POST', body: JSON.stringify({ action: 'fund' }) }), { params: Promise.resolve({ runId: run.id }) });
    const out = await res.json();
    expect(res.status, JSON.stringify(out)).toBe(200);
    expect(out.detail).toMatch(/HAND-1/);
    expect(fc.groups.find((g) => g.id === 'g-hand')!.status).toBe('FUNDED');
    fc.invoices = fc.invoices.filter((r) => !['HAND-1', 'WITH-HAND'].includes(String(r.invoiceNumber)));
  });

  it('auto-approve mode: invoices share a batch, and funding it marks every one of them funded', async () => {
    await setRules((s) => { s.mode = 'approve'; });
    const a = await send('PAIR-A', 400);
    const b = await send('PAIR-B', 450);
    expect([a.run.state, b.run.state]).toEqual(['APPROVED', 'APPROVED']);
    expect(a.run.invoiceGroupId).toBe(b.run.invoiceGroupId);
    const { actOnRun, listRuns } = await import('./funding-engine');
    const result = await actOnRun('f1', a.run.id, 'fund', 's1', 'Admin');
    expect(result.ok, result.detail).toBe(true);
    const [ra, rb] = await Promise.all([listRuns('f1', { id: a.run.id }), listRuns('f1', { id: b.run.id })]);
    expect(ra[0]).toMatchObject({ state: 'FUNDED', autoFunded: false });
    expect(rb[0]).toMatchObject({ state: 'FUNDED', autoFunded: false });
    expect(rb[0].detail).toMatch(/same FactorCloud batch as PAIR-A/);
    expect(calls.filter((c) => c.path === '/invoice-groups/fund' && c.body.invoiceGroups[0] === a.run.invoiceGroupId)).toHaveLength(1);
    expect((await actOnRun('f1', b.run.id, 'fund', 's1', 'Admin')).ok).toBe(false);
    await setRules((s) => { s.mode = 'fund'; });
    fc.invoices = fc.invoices.filter((r) => !['PAIR-A', 'PAIR-B'].includes(String(r.invoiceNumber)));
  });

  it('over the per-invoice cap: held for one click, not approved or funded', async () => {
    const { run } = await send('BIG-1', 6000);
    expect(run).toMatchObject({ outcome: 'HOLD', state: 'SUGGESTED' });
    expect(run.reasons.join(' ')).toMatch(/over the \$5,000 auto-funding cap/);
  });

  it('a client with its own rules: a higher cap funds a larger invoice; suggest-only does nothing in FactorCloud', async () => {
    await setRules((s) => { s.clientOverrides = { [CLIENT]: { name: 'Test Trucking LLC', mode: 'fund', rules: s.rules, caps: { perInvoice: 8_000, perClientPerDay: 50_000 } } }; });
    const { run, writes } = await send('BIG-2', 6000);
    expect(run).toMatchObject({ outcome: 'FUND', state: 'FUNDED', autoFunded: true });
    expect(writes).toContain('PATCH /invoice-groups/fund');

    await setRules((s) => { s.clientOverrides[CLIENT].mode = 'suggest'; });
    const quiet = await send('SUG-2', 700);
    expect(quiet.run).toMatchObject({ state: 'SUGGESTED', mode: 'suggest' });
    expect(quiet.writes.filter((w) => /verification|approve-for-funding|invoice-groups/.test(w))).toEqual([]);
    await setRules((s) => { s.clientOverrides = {}; });
    // Keep the later tests' volume and credit figures as they were.
    fc.invoices = fc.invoices.filter((r) => !['BIG-2', 'SUG-2'].includes(String(r.invoiceNumber)));
  });

  it('negative cash reserve: held', async () => {
    fc.cashReserve = -200;
    const { run } = await send('RES-1', 500);
    expect(run).toMatchObject({ outcome: 'HOLD', state: 'SUGGESTED' });
    expect(run.reasons.join(' ')).toMatch(/Cash reserve is negative/);
    fc.cashReserve = 1500;
  });

  it('paperwork sent anyway: review queue, nothing approved', async () => {
    const { run, writes } = await send('REV-1', 900, { documentAmount: 950, explanation: 'Lumper fee taken off at delivery.' });
    expect(run).toMatchObject({ outcome: 'REVIEW', state: 'REVIEW' });
    expect(writes).not.toContain('PATCH /invoices/approve-for-funding');
  });

  it('counts only approved or funded invoices toward the credit limit, like FactorCloud OpenAR', async () => {
    await setRules((s) => { s.mode = 'fund'; });
    // A pending invoice FactorCloud hasn't approved yet: not part of OpenAR.
    fc.invoices.push({ id: 'pend-1', invoiceNumber: 'PEND-1', companyClientId: CLIENT, companyDebtorId: DEBTOR, invoiceAmount: 4000, invoiceBalance: 4000, invoiceDate: iso(2), createdOn: iso(2), status: 'PENDING' });
    const approvedSoFar = fc.invoices.filter((r) => r.companyDebtorId === DEBTOR && ['APPROVED', 'FUNDED'].includes(String(r.status))).reduce((s, r) => s + Number(r.invoiceBalance), 0);
    fc.creditLimit = approvedSoFar + 1000;
    const { run } = await send('OAR-1', 900);
    expect(run.rules.find((r) => r.id === 'credit-limit')).toMatchObject({ status: 'PASS' });
    expect(run).toMatchObject({ outcome: 'FUND', state: 'FUNDED' });
    fc.invoices = fc.invoices.filter((r) => r.id !== 'pend-1');
    fc.creditLimit = 50_000;
  });

  it('try approving again re-runs the rules: funds it once everything passes', async () => {
    // Every rule passes, but FactorCloud refuses the approval (say its own credit limit is too low).
    fc.refuseApprove = true;
    const { run } = await send('RETRY-1', 700);
    fc.refuseApprove = false;
    expect(run, run.reasons.join('; ')).toMatchObject({ outcome: 'FUND', state: 'FAILED' });
    expect(run.detail).toMatch(/FactorCloud refused/);

    // Fixed in FactorCloud; one click re-checks everything and funds within the caps.
    const { POST } = await import('../app/api/ops/funding/[runId]/route');
    const res = await POST(new Request('http://portal.test/x', { method: 'POST', body: JSON.stringify({ action: 'approve' }) }), { params: Promise.resolve({ runId: run.id }) });
    const out = await res.json();
    expect(res.status, JSON.stringify(out)).toBe(200);
    expect(out.detail).toMatch(/approved and funded/);
    expect(out.run).toMatchObject({ outcome: 'FUND', state: 'FUNDED', autoFunded: true, reasons: [] });
  });

  it('try approving again with a rule still failing: held for one click with the current reason, not approved', async () => {
    fc.refuseApprove = true;
    const { run } = await send('RETRY-2', 600);
    expect(run, run.reasons.join('; ')).toMatchObject({ outcome: 'FUND', state: 'FAILED' });
    fc.refuseApprove = false; fc.cashReserve = -50;
    const { POST } = await import('../app/api/ops/funding/[runId]/route');
    const res = await POST(new Request('http://portal.test/x', { method: 'POST', body: JSON.stringify({ action: 'approve' }) }), { params: Promise.resolve({ runId: run.id }) });
    const out = await res.json();
    expect(out.run).toMatchObject({ outcome: 'HOLD', state: 'SUGGESTED', mode: 'fund' });
    expect(out.run.reasons.join(' ')).toMatch(/Cash reserve is negative/);
    fc.cashReserve = 1500;
  });

  it('catches up with changes made in FactorCloud directly', async () => {
    await setRules((s) => { s.mode = 'fund'; });
    // Three held invoices and one flagged for paperwork review.
    const fundedThere = await send('SYNC-FUNDED', 6100);
    const approvedThere = await send('SYNC-APPROVED', 6200);
    const rejectedThere = await send('SYNC-REJECTED', 6300);
    const deletedThere = await send('SYNC-DELETED', 6400);
    const reviewed = await send('SYNC-REVIEW', 900, { documentAmount: 950, explanation: 'Lumper fee taken off at delivery.' });
    for (const r of [fundedThere, approvedThere, rejectedThere, deletedThere]) expect(r.run.state).toBe('SUGGESTED');
    expect(reviewed.run.state).toBe('REVIEW');

    // Someone works them in FactorCloud instead of the portal.
    const fcInvoice = (run: { factorCloudInvoiceId: string }) => fc.invoices.find((r) => r.id === run.factorCloudInvoiceId)!;
    Object.assign(fcInvoice(fundedThere.run), { status: 'FUNDED', fundedDate: iso(0) });
    fcInvoice(approvedThere.run).status = 'APPROVED';
    fc.groups.push({ id: 'g-by-hand', code: 'BYHAND', clientId: CLIENT, status: 'NOT_FUNDED', invoiceIds: [approvedThere.run.factorCloudInvoiceId] });
    fcInvoice(rejectedThere.run).status = 'REJECTED';
    fc.invoices = fc.invoices.filter((r) => r.id !== deletedThere.run.factorCloudInvoiceId);
    fcInvoice(reviewed.run).status = 'REJECTED';

    const { syncWithFactorCloud, resetSyncClock } = await import('./factorcloud-sync');
    resetSyncClock();
    const result = await syncWithFactorCloud('f1');
    expect(result.changed).toBeGreaterThanOrEqual(5);

    const { listRuns } = await import('./funding-engine');
    const now = async (id: string) => (await listRuns('f1', { id }))[0];
    expect(await now(fundedThere.run.id)).toMatchObject({ state: 'FUNDED', autoFunded: false, detail: expect.stringMatching(/Funded in FactorCloud/) });
    expect(await now(approvedThere.run.id)).toMatchObject({ state: 'APPROVED', invoiceGroupId: 'g-by-hand', paymentType: 'ACH' });
    expect(await now(rejectedThere.run.id)).toMatchObject({ state: 'CLOSED', detail: expect.stringMatching(/Rejected in FactorCloud/) });
    expect(await now(deletedThere.run.id)).toMatchObject({ state: 'CLOSED', detail: expect.stringMatching(/deleted/) });
    const [review] = await query("select r.status, r.decision_note from review_items r join submissions s on s.id = r.submission_id where s.factorcloud_invoice_id = $1", [reviewed.run.factorCloudInvoiceId]);
    expect(review).toMatchObject({ status: 'REJECTED', decision_note: 'Rejected in FactorCloud.' });
    expect(await query("select 1 from audit_events where event_type = 'FACTORCLOUD_SYNC'")).not.toHaveLength(0);

    // Checked at most once a minute: an immediate second call reuses the result.
    expect((await syncWithFactorCloud('f1')).skipped).toBe(true);
    // Never moves money.
    expect(calls.filter((c) => c.path === '/invoice-groups/fund' && c.body.invoiceGroups[0] === 'g-by-hand')).toHaveLength(0);
    // The funding page carries the check's result.
    resetSyncClock();
    const { GET } = await import('../app/api/ops/funding/route');
    expect((await (await GET(new Request('http://portal.test/api/ops/funding?refresh=1'))).json()).sync).toMatchObject({ checked: expect.any(Number) });
    fc.invoices = fc.invoices.filter((r) => !String(r.invoiceNumber).startsWith('SYNC-'));
  });

  it('a FactorCloud reply it cannot read, or an error other than not-found, changes nothing', async () => {
    const held = await send('SYNC-ODD', 6500);
    expect(held.run.state).toBe('SUGGESTED');
    fc.invoices.find((r) => r.id === held.run.factorCloudInvoiceId)!.invoiceNumber = undefined as unknown as string; // unreadable record
    const { syncWithFactorCloud, resetSyncClock } = await import('./factorcloud-sync');
    resetSyncClock();
    await syncWithFactorCloud('f1');
    const { listRuns } = await import('./funding-engine');
    expect((await listRuns('f1', { id: held.run.id }))[0].state).toBe('SUGGESTED');
    fc.invoices = fc.invoices.filter((r) => r.id !== held.run.factorCloudInvoiceId);
    await query("update engine_runs set state='REVIEW' where id=$1", [held.run.id]);
  });

  it('suggest only: nothing done in FactorCloud until a person approves', async () => {
    await setRules((s) => { s.mode = 'suggest'; });
    const { run, writes } = await send('SUG-1', 800);
    expect(run, run.reasons.join('; ')).toMatchObject({ outcome: 'FUND', state: 'SUGGESTED' });
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

  it('an uncertain approval cannot send again until explicit reconciliation', async () => {
    await setRules(s=>{s.mode='approve';});fc.timeoutApprove=true;
    const {run}=await send('UNKNOWN-APPROVAL',200);
    expect(run.state).toBe('FAILED');
    expect((await query('select approval_status from engine_runs where id=$1',[run.id]))[0].approval_status).toBe('UNKNOWN');
    const {actOnRun}=await import('./funding-engine');const count=calls.filter(c=>c.path==='/invoices/approve-for-funding').length;
    fc.timeoutApprove=false;
    expect((await actOnRun('f1',run.id,'approve','s1','Admin')).ok).toBe(false);
    expect(calls.filter(c=>c.path==='/invoices/approve-for-funding')).toHaveLength(count);
    const [item]=await query("select id from recovery_items where run_id=$1 and kind='APPROVAL_UNKNOWN'",[run.id]);
    const {POST}=await import('../app/api/ops/recovery/route');
    expect((await POST(new Request('https://portal.test',{method:'POST',body:JSON.stringify({id:item.id,outcome:'not-approved',evidence:'Verified no approved batch exists for this invoice in FactorCloud.'})}))).status).toBe(200);
    expect((await actOnRun('f1',run.id,'approve','s1','Admin')).ok).toBe(true);
    expect(calls.filter(c=>c.path==='/invoices/approve-for-funding')).toHaveLength(count+1);
  });

  it('simultaneous approval clicks produce one FactorCloud approval',async()=>{
    await setRules(s=>{s.mode='suggest';});const {run}=await send('DOUBLE-APPROVAL',200);
    const count=calls.filter(c=>c.path==='/invoices/approve-for-funding').length;
    const {actOnRun}=await import('./funding-engine');
    const outcomes=await Promise.all([actOnRun('f1',run.id,'approve','s1','Admin'),actOnRun('f1',run.id,'approve','s1','Admin')]);
    expect(outcomes.filter(r=>r.ok)).toHaveLength(1);expect(calls.filter(c=>c.path==='/invoices/approve-for-funding')).toHaveLength(count+1);
  });

  it('lane pagination retains older unresolved work and totals ignore history limits and other factors',async()=>{
    await query("insert into factors(id,factorcloud_factor_id,name) values('f-pagination','fc-pagination','Pagination')");
    await query("insert into portal_clients(id,factor_id,factorcloud_client_id,name) values('pc-pagination','f-pagination','fc-client-pagination','Pagination client')");
    await query("insert into engine_runs(id,factor_id,client_id,factorcloud_invoice_id,factorcloud_client_id,amount,mode,outcome,state,rules,reasons,created_at) select 'pagination-approved-'||n,'f-pagination','pc-pagination','invoice-'||n,'fc-client-pagination',100,'approve','HOLD','APPROVED','[]','[]','2026-09-01T10:00:00.123456Z'::timestamptz from generate_series(1,105) n");
    await query("insert into engine_runs(id,factor_id,client_id,factorcloud_invoice_id,factorcloud_client_id,amount,mode,outcome,state,rules,reasons,auto_funded,funded_at,created_at) select 'pagination-funded-'||n,'f-pagination','pc-pagination','funded-'||n,'fc-client-pagination',50,'fund','FUND','FUNDED','[]','[]',true,now(),now() from generate_series(1,250) n");
    await query("insert into engine_runs(id,factor_id,client_id,factorcloud_invoice_id,factorcloud_client_id,amount,mode,outcome,state,rules,reasons,auto_funded,funded_at) values('pagination-manual','f-pagination','pc-pagination','manual','fc-client-pagination',900,'approve','FUND','FUNDED','[]','[]',false,now())");
    const {listRuns}=await import('./funding-engine'),{fundingSummary}=await import('./ops-funding');
    const first=await listRuns('f-pagination',{states:['APPROVED'],limit:100});
    expect(first).toHaveLength(100);expect(first.every(r=>r.state==='APPROVED')).toBe(true);expect(first[0].createdAt).toBe('2026-09-01T10:00:00.123456Z');
    const last=first.at(-1)!;
    const second=await listRuns('f-pagination',{states:['APPROVED'],before:{createdAt:last.createdAt,id:last.id},limit:100});
    expect(second).toHaveLength(5);expect(new Set([...first,...second].map(r=>r.id)).size).toBe(105);
    const summary=await fundingSummary('f-pagination');
    expect(summary.approved).toBe(105);expect(summary.approvedAmount).toBe(10500);
    expect(summary.autoToday).toBe(250);expect(summary.autoTodayAmount).toBe(12500);expect(summary.funded).toBe(251);
  });

  afterAll(async () => {
    await pool?.().end();
    vi.unstubAllGlobals();
    process.env = saved;
  });
});
