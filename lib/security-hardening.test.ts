import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({ query: vi.fn(), pool: vi.fn() }));

import { toPublicError } from './api-errors';
import { FactorCloudError, isDefinitiveCreateFailure, PublicError } from './errors';
import { clientIp, throttleBuckets } from './login-throttle';
import { sessionMismatch, type PortalSession, type SessionAccountState } from './session';
import { RECEIPT_MAX_AGE_MS, ReceiptError, signAnalysisReceipt, verifyAnalysisReceipt } from './submission-integrity';

const payload = {
  version: 1 as const,
  clientId: 'client-1',
  debtorId: 'debtor-1',
  primaryIndex: 0,
  documents: [{ fileName: 'invoice.pdf', fileHash: 'abc', sourceIndex: 0, fields: { documentType: 'invoice' } }],
} as unknown as Parameters<typeof signAnalysisReceipt>[0];

describe('analysis receipts', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PORTAL_SIGNING_SECRET = 'receipt-secret-for-tests';
    process.env.APP_ACCESS_PASSWORD = 'shared-pilot-password';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('round-trips and stamps issuedAt', () => {
    const now = Date.UTC(2026, 8, 25, 12);
    const verified = verifyAnalysisReceipt(signAnalysisReceipt(payload, now), now + 1000);
    expect(verified.issuedAt).toBe(now);
    expect(verified.clientId).toBe('client-1');
  });

  it('refuses to sign or verify without PORTAL_SIGNING_SECRET, even when APP_ACCESS_PASSWORD is set', () => {
    const receipt = signAnalysisReceipt(payload);
    delete process.env.PORTAL_SIGNING_SECRET;
    expect(() => signAnalysisReceipt(payload)).toThrow('PORTAL_SIGNING_SECRET is not configured');
    expect(() => verifyAnalysisReceipt(receipt)).toThrow('PORTAL_SIGNING_SECRET is not configured');
  });

  it('rejects a receipt forged with the shared pilot password', () => {
    process.env.PORTAL_SIGNING_SECRET = 'shared-pilot-password';
    const forged = signAnalysisReceipt(payload);
    process.env.PORTAL_SIGNING_SECRET = 'receipt-secret-for-tests';
    expect(() => verifyAnalysisReceipt(forged)).toThrow(ReceiptError);
  });

  it('expires after 24 hours and rejects receipts from the future', () => {
    const now = Date.UTC(2026, 8, 25, 12);
    const receipt = signAnalysisReceipt(payload, now);
    expect(() => verifyAnalysisReceipt(receipt, now + RECEIPT_MAX_AGE_MS - 1)).not.toThrow();
    expect(() => verifyAnalysisReceipt(receipt, now + RECEIPT_MAX_AGE_MS + 1)).toThrow('expired');
    expect(() => verifyAnalysisReceipt(receipt, now - 10 * 60 * 1000)).toThrow('expired');
  });

  it('rejects receipts issued before expiry existed (no issuedAt)', () => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', 'receipt-secret-for-tests').update(encoded).digest('base64url');
    expect(() => verifyAnalysisReceipt(`${encoded}.${signature}`)).toThrow(ReceiptError);
  });
});

describe('create retry classification', () => {
  it('treats only FactorCloud 4xx responses as definite refusals', () => {
    expect(isDefinitiveCreateFailure(new FactorCloudError('bad request', 400, null))).toBe(true);
    expect(isDefinitiveCreateFailure(new FactorCloudError('not signed in', 401, null))).toBe(true);
    expect(isDefinitiveCreateFailure(new FactorCloudError('server error', 500, null))).toBe(false);
    expect(isDefinitiveCreateFailure(new FactorCloudError('request timeout', 408, null))).toBe(false);
    expect(isDefinitiveCreateFailure(new FactorCloudError('Invoice created but the response had no invoice id.', 502, null))).toBe(false);
    expect(isDefinitiveCreateFailure(new TypeError('fetch failed'))).toBe(false);
    expect(isDefinitiveCreateFailure(new FactorCloudError('FactorCloud could not be reached (POST /invoices).', 503, null))).toBe(false);
  });
});

describe('session re-validation', () => {
  const clientSession: PortalSession = {
    v: 1, userId: 'u1', email: 'a@b.c', displayName: null, role: 'CLIENT_USER', factorId: 'f1',
    clients: [{ id: 'pc1', factorCloudClientId: 'fc-client-1', name: 'Client' }], exp: Date.now() + 60_000,
  };
  const account: SessionAccountState = { isActive: true, role: 'CLIENT_USER', factorId: 'f1', activeClientIds: ['fc-client-1'] };

  it('accepts an unchanged account', () => expect(sessionMismatch(clientSession, account)).toBeNull());
  it('rejects deleted, deactivated, re-roled or re-assigned users', () => {
    expect(sessionMismatch(clientSession, null)).toBe('user no longer exists');
    expect(sessionMismatch(clientSession, { ...account, isActive: false })).toBe('user is deactivated');
    expect(sessionMismatch(clientSession, { ...account, role: 'FACTOR_ADMIN' })).toBe('role changed');
    expect(sessionMismatch(clientSession, { ...account, factorId: 'f2' })).toBe('user belongs to a different factor');
    expect(sessionMismatch(clientSession, { ...account, activeClientIds: [] })).toBe('client assignment changed');
    expect(sessionMismatch(clientSession, { ...account, activeClientIds: ['fc-client-2'] })).toBe('client assignment changed');
  });
  it('does not require client assignments for factor staff', () => {
    const staff = { ...clientSession, role: 'FACTOR_REVIEWER' as const, clients: [] };
    expect(sessionMismatch(staff, { ...account, role: 'FACTOR_REVIEWER', activeClientIds: [] })).toBeNull();
  });
});

describe('public errors', () => {
  it('passes user-facing messages through and withholds everything else', () => {
    expect(toPublicError(new PublicError('Please sign in again.', 401))).toEqual({ error: 'Please sign in again.', status: 401 });
    expect(toPublicError(new FactorCloudError('FactorCloud POST /invoices failed (400): bad date', 400, null), 502))
      .toEqual({ error: 'FactorCloud POST /invoices failed (400): bad date', status: 502 });
    const hidden = toPublicError(new Error('relation "auth_throttle" does not exist'));
    expect(hidden.status).toBe(500);
    expect(hidden.error).not.toContain('auth_throttle');
    expect(hidden.error).toContain(hidden.reference!);
  });
});

describe('login throttle helpers', () => {
  it('hashes emails case-insensitively and adds an IP bucket when known', () => {
    const a = throttleBuckets('User@Example.com ', '203.0.113.9');
    const b = throttleBuckets('user@example.com', null);
    expect(a[0].bucket).toBe(b[0].bucket);
    expect(a[0].bucket).not.toContain('example');
    expect(a[1]).toEqual({ bucket: 'ip:203.0.113.9', maxFailures: 25 });
    expect(b).toHaveLength(1);
  });
  it('reads the first forwarded IP', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe('self-provisioned schema', () => {
  it('matches database/003_security_hardening.sql', async () => {
    const { readFileSync } = await import('fs');
    const { SECURITY_SCHEMA_STATEMENTS } = await import('./schema');
    const squash = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    const migration = squash(readFileSync(new URL('../database/003_security_hardening.sql', import.meta.url), 'utf8'));
    for (const statement of SECURITY_SCHEMA_STATEMENTS) expect(migration).toContain(`${squash(statement)};`);
  });

  it('matches database/004_client_tasks.sql', async () => {
    const { readFileSync } = await import('fs');
    const { WORKFLOW_SCHEMA_STATEMENTS } = await import('./schema');
    const squash = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    const migration = squash(readFileSync(new URL('../database/004_client_tasks.sql', import.meta.url), 'utf8'));
    for (const statement of WORKFLOW_SCHEMA_STATEMENTS) expect(migration).toContain(`${squash(statement)};`);
  });

  it('matches database/005_funding_engine.sql', async () => {
    const { readFileSync } = await import('fs');
    const { ENGINE_SCHEMA_STATEMENTS } = await import('./schema');
    const squash = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    const migration = squash(readFileSync(new URL('../database/005_funding_engine.sql', import.meta.url), 'utf8'));
    for (const statement of ENGINE_SCHEMA_STATEMENTS) expect(migration).toContain(`${squash(statement)};`);
  });
});
