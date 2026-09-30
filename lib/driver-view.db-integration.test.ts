// The Driver view with database sign-in and admin views: invoices sent from the Driver view (per
// the FactorCloud note), with the portal's fix requests and review decisions on top. Like the other
// database tests it TRUNCATEs portal tables, so it only runs with TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let sessionCookie = '';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (name === 'fc_portal_session' && sessionCookie ? { value: sessionCookie } : undefined) }) }));

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TODAY = new Date().toISOString().slice(0, 10);

describe.skipIf(!enabled)('Driver view with database sign-in (real SQL)', () => {
  const savedEnv = { ...process.env };
  let query: typeof import('./db').query;
  let pool: typeof import('./db').pool;
  let sign: typeof import('./session').signPortalSession;
  let reviewId = '';

  const clientSession = { v: 1 as const, userId: 'u1', email: 'client@x.com', displayName: null, role: 'CLIENT_USER' as const, factorId: 'f1', clients: [{ id: 'pc1', factorCloudClientId: 'fc-client-1', name: 'Client' }], exp: Date.now() + 3600_000 };
  const staffSession = { ...clientSession, userId: 's1', email: 'staff@x.com', role: 'FACTOR_ADMIN' as const, clients: [] };
  const asClient = async () => { sessionCookie = await sign(clientSession); };
  const asStaff = async () => { sessionCookie = await sign(staffSession); };
  const json = (body: unknown) => new Request('http://portal.test/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const driverList = async () => {
    const { GET } = await import('../app/api/driver/invoices/route');
    const res = await GET();
    return { status: res.status, body: await res.json() };
  };

  const note = (...parts: string[]) => ['Submitted through FactorCloud client portal', ...parts].join(' | ');
  const invoices = [
    { id: 'fc-inv-77', invoiceNumber: 'INV-77', referenceNumber: 'LD77', companyClientId: 'fc-client-1', companyDebtorId: 'd1', invoiceAmount: 500, invoiceDate: `${TODAY}T00:00:00Z`, status: 'PENDING', notes: note('PORTAL REVIEW REQUIRED', 'Sent by: Driver') },
    { id: 'fc-inv-78', invoiceNumber: 'INV-78', referenceNumber: 'LD78', companyClientId: 'fc-client-1', companyDebtorId: 'd1', invoiceAmount: 700, invoiceDate: `${TODAY}T00:00:00Z`, status: 'PENDING', notes: note('Sent by: Driver') },
    { id: 'fc-inv-79', invoiceNumber: 'INV-79', referenceNumber: 'LD79', companyClientId: 'fc-client-1', companyDebtorId: 'd1', invoiceAmount: 900, invoiceDate: `${TODAY}T00:00:00Z`, status: 'PENDING', notes: note('Sent by: Office') },
  ];

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: process.env.TEST_DATABASE_URL, PORTAL_AUTH_MODE: 'database', AUTH_SESSION_SECRET: 'session-secret-for-integration',
      FACTORCLOUD_FACTOR_ID: 'fc-factor-1', FACTORCLOUD_CLIENT_ID: 'fc-client-1', FACTORCLOUD_BEARER_TOKEN: 'token', FACTORCLOUD_API_BASE: 'https://fc.test',
      NEXT_PUBLIC_ADMIN_VIEWS: 'true',
    });
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
      const url = String(input);
      if (url.startsWith('https://fc.test/invoices?')) return new Response(JSON.stringify({ invoices }), { status: 200 });
      if (url.includes('/companies/')) return new Response(JSON.stringify({ company: { id: 'd1', companyName: 'Acme Manufacturing LLC' } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    ({ query, pool } = await import('./db'));
    ({ signPortalSession: sign } = await import('./session'));
    await query('truncate audit_events, review_items, submission_files, submissions, user_client_access, portal_users, portal_clients, factors cascade');
    await query(`insert into factors (id, factorcloud_factor_id, name) values ('f1','fc-factor-1','F')`);
    await query(`insert into portal_clients (id, factor_id, factorcloud_client_id, name) values ('pc1','f1','fc-client-1','Client')`);
    await query(`insert into portal_users (id, factor_id, email, role) values ('u1','f1','client@x.com','CLIENT_USER'), ('s1','f1','staff@x.com','FACTOR_ADMIN')`);
    await query(`insert into user_client_access (user_id, client_id) values ('u1','pc1')`);

    // The flagged invoice went through the portal, so the database has its review.
    const store = await import('./submission-store');
    const receipt = { version: 1, issuedAt: Date.now(), clientId: 'fc-client-1', debtorId: 'd1', primaryIndex: 0, documents: [{ fileName: 'inv.pdf', fileHash: 'h1', sourceIndex: 0, fields: { documentType: 'invoice', invoiceNumber: 'INV-77', referenceNumber: 'LD77', invoiceAmount: 500, invoiceDate: TODAY } }] } as never;
    const submission = await store.persistSubmissionStart({
      session: staffSession, factorCloudClientId: 'fc-client-1', receipt,
      validation: { status: 'REVIEW', checks: [{ id: 'signed-pod', label: 'Signed POD', status: 'REVIEW', message: 'POD is not signed.' }] },
      invoiceNumber: 'INV-77', referenceNumber: 'LD77', invoiceAmount: 500, invoiceDate: TODAY, analysisReceipt: 'r', files: [new File(['h1'], 'inv.pdf', { type: 'application/pdf' })],
    });
    await store.markSubmissionFactorCloudResult({ submission, session: staffSession, validationStatus: 'REVIEW', invoiceId: 'fc-inv-77' });
    [{ id: reviewId }] = await query<{ id: string }>('select id from review_items where submission_id = $1', [submission!.id]);
  });

  it('is for factor staff only', async () => {
    await asClient();
    expect((await driverList()).status).toBe(404);
  });

  it("lists what was sent from the Driver view, and shows the factor's fix request", async () => {
    await asStaff();
    const before = await driverList();
    expect(before.status).toBe(200);
    expect(before.body.invoices.map((r: { invoiceNumber: string }) => r.invoiceNumber).sort()).toEqual(['INV-77', 'INV-78']);
    expect(before.body.invoices.find((r: { id: string }) => r.id === 'fc-inv-77').status.key).toBe('CHECKING');

    const { POST } = await import('../app/api/ops/reviews/[reviewId]/route');
    expect((await POST(json({ decision: 'REQUEST_FIX', note: 'Signed POD is missing.' }), { params: Promise.resolve({ reviewId }) })).status).toBe(200);
    const row = (await driverList()).body.invoices.find((r: { id: string }) => r.id === 'fc-inv-77');
    expect(row.status).toMatchObject({ key: 'FIX', detail: 'Signed POD is missing.', needsYou: true });
    expect(row.taskId).toEqual(expect.any(String));
  });

  it('shows a rejection with its reason', async () => {
    await asStaff();
    const { POST } = await import('../app/api/ops/reviews/[reviewId]/route');
    expect((await POST(json({ decision: 'REJECT', note: 'Wrong load on the BOL.' }), { params: Promise.resolve({ reviewId }) })).status).toBe(200);
    const row = (await driverList()).body.invoices.find((r: { id: string }) => r.id === 'fc-inv-77');
    expect(row.status).toMatchObject({ key: 'REJECTED', detail: 'Wrong load on the BOL.' });
  });

  afterAll(async () => {
    await pool?.().end();
    vi.unstubAllGlobals();
    process.env = savedEnv;
  });
});

