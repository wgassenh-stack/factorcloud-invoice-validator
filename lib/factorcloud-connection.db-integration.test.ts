// Reconnect FactorCloud end to end against real SQL and a stand-in FactorCloud. Like the other
// database tests it changes portal tables, so it only runs with TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const state = vi.hoisted(() => ({ role: 'FACTOR_ADMIN', interim: undefined as string | undefined }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (name === 'fc_connect_interim' && state.interim ? { value: state.interim } : undefined), delete: () => {} }) }));
vi.mock('./demo-request', () => ({ demoRequest: async () => false }));
vi.mock('./portal-auth', () => ({ requireFactorSession: async () => ({ v: 1, userId: null, email: 'admin@factor.test', displayName: 'Dana Admin', role: state.role, factorId: 'f1', clients: [] }) }));

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const issued = jwt(Math.floor(Date.now() / 1000) + 7 * 86400);

describe.skipIf(!enabled)('reconnect FactorCloud (real SQL)', () => {
  let query: typeof import('./db').query;
  const sent: { path: string; body: Record<string, unknown>; auth?: string }[] = [];

  beforeAll(async () => {
    Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, PORTAL_AUTH_MODE: 'database', AUTH_SESSION_SECRET: 'integration-secret', FACTORCLOUD_FACTOR_ID: 'fc-factor-conn', FACTORCLOUD_API_BASE: 'https://fc.test' });
    delete process.env.FACTORCLOUD_USERNAME; delete process.env.FACTORCLOUD_PASSWORD; delete process.env.FACTORCLOUD_BEARER_TOKEN;
    ({ query } = await import('./db'));
    await query('drop table if exists factorcloud_connection'); // the route creates it on first use
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const auth = (init?.headers as Record<string, string>).Authorization;
      sent.push({ path, body, auth });
      if (path === '/authentications/generate-token') return body.password === 'right-password' ? new Response(JSON.stringify({ token: 'interim-token' })) : new Response('{"message":"bad"}', { status: 401 });
      if (path === '/authentications/login') return body.otpCode === '123456' && auth === 'Bearer interim-token' ? new Response(JSON.stringify({ data: { token: issued } })) : new Response('{"message":"bad code"}', { status: 401 });
      return auth === `Bearer ${issued}` ? new Response('{"ok":true}') : new Response('null', { status: 401 });
    }));
  });
  afterAll(async () => { vi.unstubAllGlobals(); const { pool } = await import('./db'); await pool().end(); });

  const post = async (body: Record<string, unknown>) => {
    const { POST } = await import('../app/api/ops/factorcloud-connection/route');
    const res = await POST(new Request('https://portal.test/api/ops/factorcloud-connection', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') ?? '' };
  };

  it('only a factor admin can reconnect', async () => {
    state.role = 'FACTOR_REVIEWER';
    expect(await post({ step: 'start', username: 'u', password: 'right-password' })).toMatchObject({ status: 403 });
    state.role = 'FACTOR_ADMIN';
  });

  it('a wrong password or code gets a plain message and saves nothing', async () => {
    expect(await post({ step: 'start', username: 'u', password: 'wrong' })).toMatchObject({ status: 400, body: { error: "FactorCloud didn't accept that username and password." } });
    expect(await post({ step: 'verify', code: '123456', username: 'u', password: 'right-password' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('timed out') } });
    state.interim = 'interim-token';
    expect(await post({ step: 'verify', code: '000000', username: 'u', password: 'right-password' })).toMatchObject({ status: 400, body: { error: expect.stringContaining("code didn't work") } });
    expect(await query("select to_regclass('factorcloud_connection') as t")).toEqual([{ t: null }]);
    state.interim = undefined;
  });

  it('sign in, enter the code: the token is stored encrypted and FactorCloud requests use it', async () => {
    const start = await post({ step: 'start', username: 'u', password: 'right-password' });
    expect(start.status).toBe(200);
    expect(start.cookie).toMatch(/fc_connect_interim=interim-token/);
    expect(start.cookie).toMatch(/HttpOnly/i);
    state.interim = 'interim-token';
    const done = await post({ step: 'verify', code: '123456', username: 'u', password: 'right-password' });
    expect(done).toMatchObject({ status: 200, body: { ok: true, connected: { connectedBy: 'Dana Admin' } } });
    expect(new Date(done.body.connected.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);

    const rows = await query<{ token_ciphertext: string }>('select token_ciphertext from factorcloud_connection');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_ciphertext).not.toContain(issued);
    expect(JSON.stringify(rows)).not.toContain('right-password');

    const { fcRequest } = await import('./factorcloud');
    await expect(fcRequest('/invoices')).resolves.toEqual({ ok: true });
    expect(sent.at(-1)).toMatchObject({ path: '/invoices', auth: `Bearer ${issued}` });
  });

  it('Diagnostics reports the connection and its expiry', async () => {
    const { GET } = await import('../app/api/ops/factorcloud-connection/route');
    const status = await (await GET()).json();
    expect(status).toMatchObject({ canReconnect: true, needsLogin: true, connected: { connectedBy: 'Dana Admin' }, setting: null });
    expect(JSON.stringify(status)).not.toContain(issued);
  });
});
