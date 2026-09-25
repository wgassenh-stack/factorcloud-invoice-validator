// Integration tests against a real PostgreSQL database. They TRUNCATE the portal tables, so they only
// run when TEST_DATABASE_URL points at a throwaway database (never the app's DATABASE_URL):
//   DATABASE_URL=$TEST_DATABASE_URL npm run db:migrate && TEST_DATABASE_URL=postgresql://... npm run test:db
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let cookieValue = '';
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (cookieValue ? { value: cookieValue } : undefined) }) }));

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('portal database', () => {
  const savedEnv = { ...process.env };

  let query: typeof import('./db').query;
  let pool: typeof import('./db').pool;
  let throttle: typeof import('./login-throttle');
  let auth: typeof import('./portal-auth');
  let store: typeof import('./submission-store');
  let signPortalSession: typeof import('./session').signPortalSession;
  let PublicError: typeof import('./errors').PublicError;

  const session = {
    v: 1 as const, userId: 'u1', email: 'c@x.com', displayName: null, role: 'CLIENT_USER' as const, factorId: 'f1',
    clients: [{ id: 'pc1', factorCloudClientId: 'fc-client-1', name: 'Client' }], exp: Date.now() + 3600_000,
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.PORTAL_AUTH_MODE = 'database';
    process.env.AUTH_SESSION_SECRET = 'session-secret-for-integration';
    process.env.FACTORCLOUD_FACTOR_ID = 'fc-factor-1';
    ({ query, pool } = await import('./db'));
    throttle = await import('./login-throttle');
    auth = await import('./portal-auth');
    store = await import('./submission-store');
    ({ signPortalSession } = await import('./session'));
    ({ PublicError } = await import('./errors'));
    // Start without the 003 objects to prove the app provisions them itself on first use.
    await query('drop table if exists auth_throttle');
    await query('alter table submissions drop column if exists idempotency_released_at');
    await query('truncate audit_events, review_items, submission_files, submissions, user_client_access, portal_users, portal_clients, factors cascade');
    await query(`insert into factors (id, factorcloud_factor_id, name) values ('f1','fc-factor-1','F')`);
    await query(`insert into portal_clients (id, factor_id, factorcloud_client_id, name) values ('pc1','f1','fc-client-1','Client')`);
    await query(`insert into portal_users (id, factor_id, email, role) values ('u1','f1','c@x.com','CLIENT_USER')`);
    await query(`insert into user_client_access (user_id, client_id) values ('u1','pc1')`);
  });

  describe('login throttle (real SQL)', () => {
    it('locks an email after 5 failures and clears on success', async () => {
      const buckets = throttle.throttleBuckets('victim@x.com', '203.0.113.5');
      for (let i = 0; i < 4; i++) await throttle.recordLoginFailure(buckets);
      expect(await throttle.lockedUntil(buckets)).toBeNull();
      await throttle.recordLoginFailure(buckets);
      const until = await throttle.lockedUntil(buckets);
      expect(until).not.toBeNull();
      expect(until!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      const other = throttle.throttleBuckets('someone-else@x.com', '198.51.100.1');
      expect(await throttle.lockedUntil(other)).toBeNull();
      await query(`update auth_throttle set locked_until = null where bucket like 'email:%'`);
      await throttle.clearLoginFailures(buckets);
      const rows = await query<{ bucket: string; failures: number }>('select bucket, failures from auth_throttle order by bucket');
      expect(rows.map((r) => r.bucket)).toEqual(['ip:203.0.113.5']);
      expect(rows[0].failures).toBe(5);
    });

    it('restarts the count when the window has expired', async () => {
      const buckets = throttle.throttleBuckets('slow@x.com', null);
      for (let i = 0; i < 4; i++) await throttle.recordLoginFailure(buckets);
      await query(`update auth_throttle set window_started_at = now() - interval '20 minutes' where bucket = $1`, [buckets[0].bucket]);
      await throttle.recordLoginFailure(buckets);
      const [row] = await query<{ failures: number }>('select failures from auth_throttle where bucket = $1', [buckets[0].bucket]);
      expect(row.failures).toBe(1);
      expect(await throttle.lockedUntil(buckets)).toBeNull();
    });

    it('locks an IP after 25 failures across different emails', async () => {
      for (let i = 0; i < 25; i++) await throttle.recordLoginFailure(throttle.throttleBuckets(`spray${i}@x.com`, '192.0.2.77'));
      expect(await throttle.lockedUntil(throttle.throttleBuckets('fresh@x.com', '192.0.2.77'))).not.toBeNull();
      expect(await throttle.lockedUntil(throttle.throttleBuckets('fresh@x.com', '192.0.2.78'))).toBeNull();
    });
  });

  describe('session re-validation (real SQL)', () => {
    it('follows account changes on the next request', async () => {
      cookieValue = await signPortalSession(session);
      await expect(auth.requirePortalSession()).resolves.toMatchObject({ userId: 'u1' });

      await query(`update portal_users set is_active = false where id = 'u1'`);
      await expect(auth.requirePortalSession()).rejects.toMatchObject({ status: 401 });
      expect(await auth.currentValidPortalSession()).toBeNull();
      await query(`update portal_users set is_active = true where id = 'u1'`);

      await query(`update portal_clients set is_active = false where id = 'pc1'`);
      await expect(auth.requirePortalSession()).rejects.toMatchObject({ status: 401 });
      await query(`update portal_clients set is_active = true where id = 'pc1'`);

      await query(`update portal_users set role = 'FACTOR_REVIEWER' where id = 'u1'`);
      await expect(auth.requirePortalSession()).rejects.toMatchObject({ status: 401 });
      await query(`update portal_users set role = 'CLIENT_USER' where id = 'u1'`);

      await expect(auth.resolveConfiguredClientId()).resolves.toBe('fc-client-1');
      await expect(auth.requireFactorSession()).rejects.toMatchObject({ status: 403 });
    });

    it('keeps ops closed without database auth', async () => {
      process.env.PORTAL_AUTH_MODE = 'pilot';
      await expect(auth.requireFactorSession()).rejects.toMatchObject({ status: 404 });
      process.env.PORTAL_AUTH_MODE = 'database';
    });
  });

  describe('submission retry rules (real SQL)', () => {
    const file = (name: string, body: string) => new File([body], name, { type: 'application/pdf' });
    const receipt = (hashes: string[]) => ({
      version: 1 as const, issuedAt: Date.now(), clientId: 'fc-client-1', debtorId: 'd1', primaryIndex: 0,
      documents: hashes.map((h, i) => ({ fileName: `f${i}.pdf`, fileHash: h, sourceIndex: i, fields: { documentType: 'invoice', invoiceNumber: 'INV-9', referenceNumber: null, invoiceAmount: 100, invoiceDate: '2026-09-25' } })),
    }) as never;
    const start = (invoiceNumber: string, hashes = ['h1']) => store.persistSubmissionStart({
      session, factorCloudClientId: 'fc-client-1', receipt: receipt(hashes), validation: { status: 'PASS', checks: [] },
      invoiceNumber, referenceNumber: null, invoiceAmount: 100, invoiceDate: '2026-09-25', analysisReceipt: 'r', files: hashes.map((h) => file(`${h}.pdf`, h)),
    });

    it('allows a retry after a definite FactorCloud refusal', async () => {
      const first = await start('INV-9');
      await store.markSubmissionFactorCloudResult({ submission: first, session, validationStatus: 'PASS', error: 'FactorCloud 400', retryable: true });
      const second = await start('INV-9');
      expect(second!.id).not.toBe(first!.id);
      const rows = await query<{ id: string; workflow_status: string; idempotency_key: string; idempotency_released_at: Date | null }>(
        'select id, workflow_status, idempotency_key, idempotency_released_at from submissions order by created_at');
      expect(rows[0].idempotency_key).toContain(store.RELEASED_KEY_MARKER);
      expect(rows[0].idempotency_released_at).not.toBeNull();
      const [audit] = await query<{ event_data: { retryAllowed: boolean } }>(`select event_data from audit_events where event_type='FACTORCLOUD_CREATE_FAILED'`);
      expect(audit.event_data.retryAllowed).toBe(true);
    });

    it('blocks a retry after an uncertain failure, with an explanatory message', async () => {
      const sub = await start('INV-10');
      await store.markSubmissionFactorCloudResult({ submission: sub, session, validationStatus: 'PASS', error: 'fetch failed', retryable: false });
      await expect(start('INV-10')).rejects.toThrow(/without a clear result/);
      await expect(start('INV-10')).rejects.toBeInstanceOf(store.SubmissionConflictError);
    });

    it('blocks a resubmission of a created invoice', async () => {
      const sub = await start('INV-11');
      await store.markSubmissionFactorCloudResult({ submission: sub, session, validationStatus: 'PASS', invoiceId: 'fc-inv-11' });
      await expect(start('INV-11')).rejects.toThrow(/already being processed or was already submitted/);
      // retryable is ignored once an invoice exists
      await store.markSubmissionFactorCloudResult({ submission: sub, session, validationStatus: 'PASS', invoiceId: 'fc-inv-11', error: 'x', retryable: true });
      await expect(start('INV-11')).rejects.toBeInstanceOf(store.SubmissionConflictError);
    });

    it('explains a duplicate file inside one packet', async () => {
      const err = await start('INV-12', ['same', 'same']).catch((e) => e);
      expect(err).toBeInstanceOf(PublicError);
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/same file appears more than once/);
    });
  });


  afterAll(async () => {
    await pool?.().end();
    process.env = savedEnv;
  });
});
