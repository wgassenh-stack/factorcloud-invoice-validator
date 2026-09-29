// End-to-end "request a fix" flow against a real PostgreSQL database, through the route handlers.
// Like db-integration.test.ts it TRUNCATEs portal tables, so it only runs with TEST_DATABASE_URL:
//   TEST_DATABASE_URL=postgresql://... npm run test:db
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let sessionCookie = '';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (name === 'fc_portal_session' && sessionCookie ? { value: sessionCookie } : undefined) }) }));

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('request a fix (real SQL)', () => {
  const savedEnv = { ...process.env };
  const sent: { url: string; body: unknown; method?: string }[] = [];
  let labelsOn = ['l-review'];
  let query: typeof import('./db').query;
  let pool: typeof import('./db').pool;
  let sign: typeof import('./session').signPortalSession;
  let reviewId = '';
  let submissionId = '';

  const clientSession = { v: 1 as const, userId: 'u1', email: 'client@x.com', displayName: null, role: 'CLIENT_USER' as const, factorId: 'f1', clients: [{ id: 'pc1', factorCloudClientId: 'fc-client-1', name: 'Client' }], exp: Date.now() + 3600_000 };
  const staffSession = { ...clientSession, userId: 's1', email: 'staff@x.com', role: 'FACTOR_ADMIN' as const, clients: [] };
  const asClient = async () => { sessionCookie = await sign(clientSession); };
  const asStaff = async () => { sessionCookie = await sign(staffSession); };
  const json = (body: unknown) => new Request('http://portal.test/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: process.env.TEST_DATABASE_URL, PORTAL_AUTH_MODE: 'database', AUTH_SESSION_SECRET: 'session-secret-for-integration',
      FACTORCLOUD_FACTOR_ID: 'fc-factor-1', FACTORCLOUD_CLIENT_ID: 'fc-client-1', FACTORCLOUD_BEARER_TOKEN: 'token', FACTORCLOUD_API_BASE: 'https://fc.test',
    });
    // Fake FactorCloud: record every call, answer like the documented API.
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      sent.push({ url, body, method: init?.method });
      if (url.startsWith('https://fc.test/documents')) return new Response(JSON.stringify({ document: { id: `doc-${sent.length}` } }), { status: 200 });
      if (url.includes('/documents')) return new Response(JSON.stringify({ status: 'SUCCESS' }), { status: 200 });
      if (url.includes('/companies/')) return new Response(JSON.stringify({ company: { id: 'fc-client-1', companyName: 'Client Co' } }), { status: 200 });
      // Writing the decision back: the invoice's notes and its labels.
      if (url === 'https://fc.test/labels?entityType=INVOICE') return new Response(JSON.stringify([{ id: 'l-review', name: 'Portal review.' }]), { status: 200 });
      if (url === 'https://fc.test/invoices/fc-inv-77/labels') {
        if (init?.method === 'PATCH') labelsOn = (body as { labelIds: string[] }).labelIds;
        return new Response(JSON.stringify(labelsOn.map((id) => ({ id, name: id === 'l-review' ? 'Portal review.' : id }))), { status: 200 });
      }
      if (url === 'https://fc.test/invoices/fc-inv-77') return new Response(JSON.stringify({ invoice: { id: 'fc-inv-77', notes: 'Submitted through FactorCloud client portal | PORTAL REVIEW REQUIRED' } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    ({ query, pool } = await import('./db'));
    ({ signPortalSession: sign } = await import('./session'));
    await query('drop table if exists client_tasks');
    await query('truncate audit_events, review_items, submission_files, submissions, user_client_access, portal_users, portal_clients, factors cascade');
    await query(`insert into factors (id, factorcloud_factor_id, name) values ('f1','fc-factor-1','F')`);
    await query(`insert into portal_clients (id, factor_id, factorcloud_client_id, name) values ('pc1','f1','fc-client-1','Client')`);
    await query(`insert into portal_users (id, factor_id, email, role) values ('u1','f1','client@x.com','CLIENT_USER'), ('s1','f1','staff@x.com','FACTOR_ADMIN')`);
    await query(`insert into user_client_access (user_id, client_id) values ('u1','pc1')`);

    const store = await import('./submission-store');
    const receipt = { version: 1, issuedAt: Date.now(), clientId: 'fc-client-1', debtorId: 'd1', primaryIndex: 0, documents: [{ fileName: 'inv.pdf', fileHash: 'h1', sourceIndex: 0, fields: { documentType: 'invoice', invoiceNumber: 'INV-77', referenceNumber: null, invoiceAmount: 500, invoiceDate: '2026-09-25' } }] } as never;
    const submission = await store.persistSubmissionStart({
      session: clientSession, factorCloudClientId: 'fc-client-1', receipt,
      validation: { status: 'REVIEW', checks: [{ id: 'signed-pod', label: 'Signed POD', status: 'REVIEW', message: 'POD is not signed.' }] },
      invoiceNumber: 'INV-77', referenceNumber: null, invoiceAmount: 500, invoiceDate: '2026-09-25', analysisReceipt: 'r', files: [new File(['h1'], 'inv.pdf', { type: 'application/pdf' })],
    });
    await store.markSubmissionFactorCloudResult({ submission, session: clientSession, validationStatus: 'REVIEW', invoiceId: 'fc-inv-77' });
    submissionId = submission!.id;
    [{ id: reviewId }] = await query<{ id: string }>('select id from review_items where submission_id = $1', [submissionId]);
  });

  it('staff request a fix: the review stays open and the client gets a task', async () => {
    await asStaff();
    const { POST } = await import('../app/api/ops/reviews/[reviewId]/route');
    const res = await POST(json({ decision: 'REQUEST_FIX', note: 'Signed POD is missing.' }), { params: Promise.resolve({ reviewId }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'FIX_REQUESTED' });
    const [review] = await query<{ status: string }>('select status from review_items where id = $1', [reviewId]);
    const [sub] = await query<{ workflow_status: string }>('select workflow_status from submissions where id = $1', [submissionId]);
    expect(review.status).toBe('OPEN');
    expect(sub.workflow_status).toBe('REVIEW_REQUIRED');
  });

  it('the client sees the task, and a different client cannot answer it', async () => {
    await asClient();
    const { GET } = await import('../app/api/tasks/route');
    const { tasks } = await (await GET()).json();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ invoiceId: 'fc-inv-77', invoiceNumber: 'INV-77', message: 'Signed POD is missing.' });

    const { clientTask } = await import('./client-tasks');
    expect(await clientTask(tasks[0].id, 'f1', 'some-other-client')).toBeNull();
  });

  it('the client uploads the fix: files attach to the same FactorCloud invoice and it returns to review', async () => {
    await asClient();
    const { GET } = await import('../app/api/tasks/route');
    const [task] = (await (await GET()).json()).tasks;
    const form = new FormData();
    form.append('files', new File(['signed pod bytes'], 'pod-signed.pdf', { type: 'application/pdf' }));
    form.append('documentType', 'pod');
    form.append('note', 'Signed POD attached');
    const before = sent.length;
    const { POST } = await import('../app/api/tasks/[taskId]/route');
    const res = await POST(new Request('http://portal.test/x', { method: 'POST', body: form }), { params: Promise.resolve({ taskId: task.id }) });
    expect(res.status).toBe(200);

    const calls = sent.slice(before);
    expect(calls.find((c) => c.url.startsWith('https://fc.test/documents'))!.url).toContain('type=POD');
    expect(calls.find((c) => c.url === 'https://fc.test/invoices/fc-inv-77/documents')!.body).toEqual({ documentIds: [expect.stringMatching(/^doc-/)] });

    const [row] = await query<{ status: string; response_note: string }>('select status, response_note from client_tasks where id = $1', [task.id]);
    expect(row).toEqual({ status: 'DONE', response_note: 'Signed POD attached' });
    const [sub] = await query<{ workflow_status: string }>('select workflow_status from submissions where id = $1', [submissionId]);
    expect(sub.workflow_status).toBe('REVIEW_REQUIRED');
    const files = await query<{ original_file_name: string; source_index: number }>('select original_file_name, source_index from submission_files where submission_id = $1 order by source_index', [submissionId]);
    expect(files.map((f) => f.original_file_name)).toEqual(['inv.pdf', 'pod-signed.pdf']);
    const events = await query<{ event_type: string }>('select event_type from audit_events where submission_id = $1 order by created_at', [submissionId]);
    expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['FIX_REQUESTED', 'FIX_SUBMITTED']));

    // Answering twice is refused.
    const again = await POST(new Request('http://portal.test/x', { method: 'POST', body: form }), { params: Promise.resolve({ taskId: task.id }) });
    expect(again.status).toBe(404);
  });

  it('the queue shows the client responded, and approving closes it', async () => {
    await asStaff();
    const list = await (await (await import('../app/api/ops/reviews/route')).GET()).json();
    expect(list.records[0].fix).toMatchObject({ status: 'DONE', responseNote: 'Signed POD attached' });
    const { POST } = await import('../app/api/ops/reviews/[reviewId]/route');
    const before = sent.length;
    const res = await POST(json({ decision: 'APPROVE' }), { params: Promise.resolve({ reviewId }) });
    expect(await res.json()).toMatchObject({ status: 'APPROVED', factorCloud: { ok: true } });
    // Written back to FactorCloud: a note line, and the review label taken off.
    const notes = sent.slice(before).find((c) => c.method === 'PUT' && c.url === 'https://fc.test/invoices/fc-inv-77');
    expect((notes!.body as { notes: string }).notes).toMatch(/PORTAL REVIEW REQUIRED \| Portal update: approved in the portal by /);
    expect(labelsOn).toEqual([]);
  });

  afterAll(async () => {
    await pool?.().end();
    vi.unstubAllGlobals();
    process.env = savedEnv;
  });
});
