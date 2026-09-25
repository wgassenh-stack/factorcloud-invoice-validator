import { describe, expect, it } from 'vitest';
import { signPortalSession, verifyPortalSession, type PortalSession } from './session';

const secret = 'test-secret-that-is-long-enough-for-session-signing';

function sample(exp = Date.now() + 60_000): PortalSession {
  return {
    v: 1,
    userId: 'user-1',
    email: 'driver@example.com',
    displayName: 'Driver One',
    role: 'CLIENT_USER',
    factorId: 'factor-1',
    clients: [{ id: 'client-1', factorCloudClientId: 'fc-client-1', name: 'Carrier One' }],
    exp,
  };
}

describe('portal sessions', () => {
  it('round trips a signed session', async () => {
    const token = await signPortalSession(sample(), secret);
    const parsed = await verifyPortalSession(token, secret);
    expect(parsed?.userId).toBe('user-1');
    expect(parsed?.clients[0].factorCloudClientId).toBe('fc-client-1');
  });

  it('rejects a modified signature', async () => {
    const token = await signPortalSession(sample(), secret);
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(await verifyPortalSession(tampered, secret)).toBeNull();
  });

  it('rejects expired sessions', async () => {
    const token = await signPortalSession(sample(Date.now() - 1), secret);
    expect(await verifyPortalSession(token, secret)).toBeNull();
  });
});
