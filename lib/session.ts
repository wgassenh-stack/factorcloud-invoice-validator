export type PortalRole = 'FACTOR_ADMIN' | 'FACTOR_REVIEWER' | 'CLIENT_USER';

export interface PortalSessionClient {
  id: string;
  factorCloudClientId: string;
  name: string;
}

export interface PortalSession {
  v: 1;
  userId: string;
  email: string;
  displayName: string | null;
  role: PortalRole;
  factorId: string;
  clients: PortalSessionClient[];
  exp: number;
}

export const PORTAL_SESSION_COOKIE = 'fc_portal_session';

export function databaseAuthEnabled(): boolean {
  // Demo mode never touches the database, whatever PORTAL_AUTH_MODE says.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') return false;
  return process.env.PORTAL_AUTH_MODE === 'database';
}

export async function signPortalSession(session: PortalSession, secret = process.env.AUTH_SESSION_SECRET): Promise<string> {
  if (!secret) throw new Error('AUTH_SESSION_SECRET is not configured.');
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(session)));
  const signature = await hmac(encoded, secret);
  return `${encoded}.${base64UrlEncode(signature)}`;
}

export async function verifyPortalSession(token: string | undefined | null, secret = process.env.AUTH_SESSION_SECRET): Promise<PortalSession | null> {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    const expected = await hmac(parts[0], secret);
    const actual = base64UrlDecode(parts[1]);
    if (!safeEqual(expected, actual)) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as PortalSession;
    if (payload.v !== 1 || !payload.userId || !payload.factorId || !payload.role || payload.exp <= Date.now()) return null;
    if (!['FACTOR_ADMIN', 'FACTOR_REVIEWER', 'CLIENT_USER'].includes(payload.role)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The account state a session is re-checked against on every protected request. */
export interface SessionAccountState {
  isActive: boolean;
  role: PortalRole;
  factorId: string;
  /** FactorCloud client IDs of the user's active client assignments. */
  activeClientIds: string[];
}

/**
 * A signed session is only a snapshot of the account at login. Returns null when the snapshot still
 * matches the account, or the reason it no longer does (user removed or deactivated, role changed,
 * or client assignment changed). Any mismatch means the user must sign in again.
 */
export function sessionMismatch(session: PortalSession, account: SessionAccountState | null): string | null {
  if (!account) return 'user no longer exists';
  if (!account.isActive) return 'user is deactivated';
  if (account.factorId !== session.factorId) return 'user belongs to a different factor';
  if (account.role !== session.role) return 'role changed';
  if (session.role === 'CLIENT_USER') {
    const assigned = session.clients[0]?.factorCloudClientId;
    if (session.clients.length !== 1 || !assigned) return 'session has no single client';
    if (account.activeClientIds.length !== 1 || account.activeClientIds[0] !== assigned) return 'client assignment changed';
  }
  return null;
}
