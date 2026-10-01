import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { databaseConfigured, query } from './db';
import { ensureConnectionSchema } from './schema';
import { tokenExpiry } from './token-expiry';

// The FactorCloud access token a factor admin connected from the portal (Diagnostics → Reconnect).
// FactorCloud tokens expire and its sign-in needs an emailed code, so the server can't renew one by
// itself; this lets an admin renew it in the portal instead of copying a token into the deployment
// settings and redeploying. The token is stored encrypted, and read back at most every 30 seconds.

const CACHE_MS = 30_000;
let cache: { at: number; value: StoredToken | null } | null = null;

export interface StoredToken {
  token: string;
  expiresAt: string | null;
  connectedBy: string | null;
  connectedAt: string;
}

/** The key for the stored token: its own setting if given, otherwise derived from the session secret. */
function key(): Buffer | null {
  const secret = process.env.FACTORCLOUD_TOKEN_KEY || process.env.AUTH_SESSION_SECRET;
  return secret ? createHash('sha256').update(`factorcloud-connection:v1:${secret}`).digest() : null;
}

export function encryptToken(token: string, k: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptToken(sealed: string, k: Buffer): string | null {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong key (the secret changed) or tampered: treated as not connected
  }
}

/** Whether this deployment can keep a connected token: a database and a secret to encrypt it with. */
export function canStoreToken(): boolean {
  return databaseConfigured() && Boolean(key()) && Boolean(process.env.FACTORCLOUD_FACTOR_ID);
}

/** The connected token, or null. Never throws: a missing table or unreadable row just means "not connected". */
export async function storedToken(): Promise<StoredToken | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: StoredToken | null = null;
  const k = key();
  if (k && canStoreToken()) {
    try {
      const [row] = await query<{ token_ciphertext: string; expires_at: Date | null; connected_by_name: string | null; connected_at: Date }>(
        'select token_ciphertext, expires_at, connected_by_name, connected_at from factorcloud_connection where factorcloud_factor_id = $1',
        [process.env.FACTORCLOUD_FACTOR_ID]);
      const token = row ? decryptToken(row.token_ciphertext, k) : null;
      if (row && token) value = { token, expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, connectedBy: row.connected_by_name, connectedAt: new Date(row.connected_at).toISOString() };
      else if (row) console.error('[factorcloud-connection] the stored token could not be decrypted (has the secret changed?). Reconnect FactorCloud on the Diagnostics page.');
    } catch (err) {
      if ((err as { code?: string }).code !== '42P01') console.error('[factorcloud-connection] could not read the stored token', err);
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

/** Saves a newly connected token, replacing the previous one. */
export async function saveToken(token: string, by: { userId: string | null; name: string }): Promise<StoredToken> {
  const k = key();
  if (!k || !canStoreToken()) throw new Error('This deployment cannot store a FactorCloud connection (it needs the portal database and a session secret).');
  await ensureConnectionSchema();
  const expires = tokenExpiry(token);
  await query(`
    insert into factorcloud_connection (factorcloud_factor_id, token_ciphertext, expires_at, connected_by_user_id, connected_by_name, connected_at)
    values ($1, $2, $3, $4, $5, now())
    on conflict (factorcloud_factor_id) do update set token_ciphertext = excluded.token_ciphertext, expires_at = excluded.expires_at,
      connected_by_user_id = excluded.connected_by_user_id, connected_by_name = excluded.connected_by_name, connected_at = now()`,
    [process.env.FACTORCLOUD_FACTOR_ID, encryptToken(token, k), expires, by.userId, by.name]);
  cache = null;
  return (await storedToken()) ?? { token, expiresAt: expires?.toISOString() ?? null, connectedBy: by.name, connectedAt: new Date().toISOString() };
}

/** For tests: forget the cached token. */
export function resetConnectionCache(): void {
  cache = null;
}
