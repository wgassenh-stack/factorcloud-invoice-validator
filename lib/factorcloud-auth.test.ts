import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ value: undefined as string | undefined, deleted: 0 }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => (jar.value ? { value: jar.value } : undefined),
    delete: () => { jar.value = undefined; jar.deleted++; },
  }),
}));
vi.mock('./demo-request', () => ({ demoRequest: async () => false }));

import { fcRequest, SERVICE_TOKEN_REJECTED, SESSION_EXPIRED } from './factorcloud';
import { FactorCloudError } from './errors';
import { tokenExpiry, tokenExpiryCheck } from './token-expiry';

/** FactorCloud that accepts only the given token. */
function fakeFactorCloud(valid: string) {
  const seen: string[] = [];
  const fetchMock = vi.fn(async (_input: URL | string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    seen.push(auth);
    return auth === `Bearer ${valid}`
      ? new Response(JSON.stringify({ status: 'SUCCESS', company: { id: 'c1' } }), { status: 200 })
      : new Response('null', { status: 401 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return seen;
}

describe('rejected FactorCloud credentials', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { FACTORCLOUD_FACTOR_ID: 'f', FACTORCLOUD_API_BASE: 'https://fc.test', FACTORCLOUD_BEARER_TOKEN: 'service' });
    jar.value = undefined; jar.deleted = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('an expired service token gives a plain message, not the raw 401', async () => {
    fakeFactorCloud('something-else');
    const err = await fcRequest('/companies/c1').catch((e: unknown) => e) as FactorCloudError;
    expect(err).toBeInstanceOf(FactorCloudError);
    expect(err.status).toBe(401);
    expect(err.message).toBe(SERVICE_TOKEN_REJECTED);
    expect(err.message).not.toMatch(/null|GET/);
  });

  it('an expired staff sign-in is dropped and the service token is used instead', async () => {
    jar.value = 'stale-session';
    const seen = fakeFactorCloud('service');
    await expect(fcRequest('/companies/c1')).resolves.toMatchObject({ company: { id: 'c1' } });
    expect(seen).toEqual(['Bearer stale-session', 'Bearer service']);
    expect(jar.deleted).toBe(1);
  });

  it('a write is resent once with the service token, since the refused one did nothing', async () => {
    jar.value = 'stale-session';
    const seen = fakeFactorCloud('service');
    await fcRequest('/invoices', { method: 'POST', json: { a: 1 } });
    expect(seen).toEqual(['Bearer stale-session', 'Bearer service']);
  });

  it('with no service token, an expired staff sign-in asks to sign in again', async () => {
    delete process.env.FACTORCLOUD_BEARER_TOKEN;
    jar.value = 'stale-session';
    fakeFactorCloud('service');
    await expect(fcRequest('/companies/c1')).rejects.toMatchObject({ status: 401, message: SESSION_EXPIRED });
    expect(jar.deleted).toBe(1);
  });

  it('other errors keep their detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'no such company' }), { status: 404 })));
    await expect(fcRequest('/companies/x')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('no such company') });
  });
});

describe('token expiry', () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ sub: 'x', exp })).toString('base64url')}.sig`;
  const now = new Date('2026-10-01T12:00:00Z');
  const at = (ms: number) => jwt(Math.floor((now.getTime() + ms) / 1000));

  it('reads the expiry from a JWT and nothing from an opaque token', () => {
    expect(tokenExpiry(jwt(1_800_000_000))?.toISOString()).toBe('2027-01-15T08:00:00.000Z');
    expect(tokenExpiry('opaque-token')).toBeNull();
    expect(tokenExpiry('a.not-json.b')).toBeNull();
  });

  it('fails when expired, warns in the last 3 days, and is fine otherwise', () => {
    expect(tokenExpiryCheck(at(-60_000), now).state).toBe('fail');
    expect(tokenExpiryCheck(at(5 * 3600_000), now)).toMatchObject({ state: 'warn', detail: expect.stringContaining('in 5 hours') });
    expect(tokenExpiryCheck(at(36 * 3600_000), now)).toMatchObject({ state: 'warn', detail: expect.stringContaining('in 36 hours') });
    expect(tokenExpiryCheck(at(7 * 86400_000), now).state).toBe('ok');
    expect(tokenExpiryCheck(at(30 * 86400_000), now).state).toBe('ok');
    expect(tokenExpiryCheck('opaque', now).state).toBe('skip');
  });

  it('never repeats the token', () => {
    const token = at(-1);
    expect(tokenExpiryCheck(token, now).detail).not.toContain(token);
  });
});
