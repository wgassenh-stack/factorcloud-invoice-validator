import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let cookieValue: string | undefined;
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (name === 'fc_demo' && cookieValue ? { value: cookieValue } : undefined) }) }));

import { demoFromCookie } from './demo';
import { getCompany, listInvoices } from './factorcloud';
import { resolveConfiguredClientId } from './portal-auth';

describe('per-browser demo switch', () => {
  const saved = { ...process.env };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ invoices: [] }), { status: 200 }));
  beforeEach(() => {
    cookieValue = undefined;
    process.env.FACTORCLOUD_FACTOR_ID = 'factor-1';
    process.env.FACTORCLOUD_BEARER_TOKEN = 'token';
    process.env.FACTORCLOUD_CLIENT_ID = 'real-client';
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
    delete process.env.NEXT_PUBLIC_DEMO_TOGGLE;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  it('reads the cookie, the site-wide setting and the hide switch', () => {
    expect(demoFromCookie(undefined)).toBe(false);
    expect(demoFromCookie('1')).toBe(true);
    expect(demoFromCookie('yes')).toBe(false);
    process.env.NEXT_PUBLIC_DEMO_TOGGLE = 'false';
    expect(demoFromCookie('1')).toBe(false);
    process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
    expect(demoFromCookie(undefined)).toBe(true);
  });

  it('serves fake data and never calls FactorCloud when the cookie is set', async () => {
    cookieValue = '1';
    const list = await listInvoices();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(list.raw)).toContain('demo-inv-');
    expect((await getCompany('demo-debtor-01')).companyName).toBe('Acme Manufacturing LLC');
    expect(await resolveConfiguredClientId()).toBe('demo-client-01');
  });

  it('uses the real FactorCloud client without the cookie', async () => {
    await listInvoices();
    expect(fetchMock).toHaveBeenCalled();
    expect(await resolveConfiguredClientId()).toBe('real-client');
  });

  it('ignores the cookie when the switch is hidden', async () => {
    process.env.NEXT_PUBLIC_DEMO_TOGGLE = 'false';
    cookieValue = '1';
    await listInvoices();
    expect(fetchMock).toHaveBeenCalled();
    expect(await resolveConfiguredClientId()).toBe('real-client');
  });
});
