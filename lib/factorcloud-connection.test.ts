import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
const stored = vi.hoisted(() => ({ token: null as string | null }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (jar.value ? { value: jar.value } : undefined), delete: () => { jar.value = undefined; } }),
}));
vi.mock('./demo-request', () => ({ demoRequest: async () => false }));
vi.mock('./factorcloud-connection', async (original) => ({
  ...(await original<typeof import('./factorcloud-connection')>()),
  storedToken: async () => (stored.token ? { token: stored.token, expiresAt: null, connectedBy: 'Admin', connectedAt: new Date().toISOString() } : null),
}));

import { decryptToken, encryptToken } from './factorcloud-connection';
import { fcRequest, SERVICE_TOKEN_REJECTED } from './factorcloud';

const key = createHash('sha256').update('k').digest();

describe('stored FactorCloud token encryption', () => {
  it('round-trips, and never stores the token in the clear', () => {
    const sealed = encryptToken('secret-token-value', key);
    expect(sealed).not.toContain('secret-token-value');
    expect(decryptToken(sealed, key)).toBe('secret-token-value');
    expect(encryptToken('secret-token-value', key)).not.toBe(sealed); // fresh IV each time
  });

  it('reads as not connected with the wrong key or a tampered value', () => {
    const sealed = encryptToken('secret-token-value', key);
    expect(decryptToken(sealed, createHash('sha256').update('other').digest())).toBeNull();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(decryptToken(parts.join('.'), key)).toBeNull();
    expect(decryptToken('garbage', key)).toBeNull();
  });
});

describe('which token a FactorCloud request uses', () => {
  const saved = { ...process.env };
  let seen: string[] = [];
  const accept = (valid: string[]) => vi.stubGlobal('fetch', vi.fn(async (_u: URL | string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    seen.push(auth.replace('Bearer ', ''));
    return valid.includes(auth.replace('Bearer ', '')) ? new Response('{"ok":true}', { status: 200 }) : new Response('null', { status: 401 });
  }));
  beforeEach(() => {
    Object.assign(process.env, { FACTORCLOUD_FACTOR_ID: 'f', FACTORCLOUD_API_BASE: 'https://fc.test', FACTORCLOUD_BEARER_TOKEN: 'setting' });
    jar.value = undefined; stored.token = null; seen = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('prefers the token connected in the portal over the deployment setting', async () => {
    stored.token = 'connected';
    accept(['connected', 'setting']);
    await fcRequest('/x');
    expect(seen).toEqual(['connected']);
  });

  it('falls back from an expired connected token to the setting', async () => {
    stored.token = 'connected';
    accept(['setting']);
    await fcRequest('/x');
    expect(seen).toEqual(['connected', 'setting']);
  });

  it('tries staff sign-in, then connected, then setting, and explains plainly when none works', async () => {
    jar.value = 'session'; stored.token = 'connected';
    accept([]);
    await expect(fcRequest('/x', { method: 'POST', json: {} })).rejects.toMatchObject({ status: 401, message: SERVICE_TOKEN_REJECTED });
    expect(seen).toEqual(['session', 'connected', 'setting']);
  });

  it('does not try the same token twice', async () => {
    stored.token = 'setting';
    accept([]);
    await expect(fcRequest('/x')).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual(['setting']);
  });
});

describe('self-provisioned schema', () => {
  it('matches database/009_factorcloud_connection.sql', async () => {
    const { readFileSync } = await import('fs');
    const { CONNECTION_SCHEMA_STATEMENTS } = await import('./schema');
    const squash = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    const migration = squash(readFileSync(new URL('../database/009_factorcloud_connection.sql', import.meta.url), 'utf8'));
    for (const statement of CONNECTION_SCHEMA_STATEMENTS) expect(migration).toContain(`${squash(statement)};`);
  });
});
