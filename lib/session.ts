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
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, actual, new TextEncoder().encode(parts[0]));
    if (!ok || actual.length !== expected.length) return null;
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
