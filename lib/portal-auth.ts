import 'server-only';

import { cookies } from 'next/headers';
import { query } from './db';
import { PublicError } from './errors';
import { DEMO_CLIENT_ID, adminViewsEnabled } from './demo';
import { DEMO_SESSION } from './demo-store';
import { databaseAuthEnabled, PORTAL_SESSION_COOKIE, sessionMismatch, verifyPortalSession, type PortalRole, type PortalSession, type SessionAccountState } from './session';
import { demoRequest } from './demo-request';

type UserRow = {
  id: string;
  factor_id: string;
  email: string;
  display_name: string | null;
  role: PortalRole;
  is_active: boolean;
  password_hash: string | null;
};

type ClientRow = {
  id: string;
  factorcloud_client_id: string;
  name: string;
};

export async function currentPortalSession(): Promise<PortalSession | null> {
  if (!databaseAuthEnabled()) return null;
  const jar = await cookies();
  return verifyPortalSession(jar.get(PORTAL_SESSION_COOKIE)?.value);
}

/**
 * The signed session, re-checked against the database. Every protected API goes through this, so
 * deactivating a user, changing their role or removing their client assignment takes effect on
 * their next request instead of when the 8-hour session cookie expires.
 */
export async function requirePortalSession(): Promise<PortalSession> {
  if (await demoRequest()) return DEMO_SESSION;
  const session = await currentPortalSession();
  if (!session) throw new PortalAccessError('Portal authentication required.', 401);
  const mismatch = sessionMismatch(session, await loadAccountState(session.userId));
  if (mismatch) throw new PortalAccessError('Your access has changed. Please sign in again.', 401);
  return session;
}

/** Like requirePortalSession, but returns null instead of throwing. */
export async function currentValidPortalSession(): Promise<PortalSession | null> {
  try {
    return await requirePortalSession();
  } catch (err) {
    if (err instanceof PortalAccessError) return null;
    throw err;
  }
}

async function loadAccountState(userId: string): Promise<SessionAccountState | null> {
  const rows = await query<{ is_active: boolean; role: PortalRole; factor_id: string; client_ids: string[] }>(`
    select u.is_active, u.role, u.factor_id,
      coalesce(array_agg(c.factorcloud_client_id) filter (where c.id is not null and c.is_active), '{}') as client_ids
    from portal_users u
    left join user_client_access a on a.user_id = u.id
    left join portal_clients c on c.id = a.client_id
    where u.id = $1
    group by u.id
  `, [userId]);
  const row = rows[0];
  return row ? { isActive: row.is_active, role: row.role, factorId: row.factor_id, activeClientIds: row.client_ids } : null;
}

/**
 * Shared-password deployment with admin views on: whoever holds the site password is the factor's
 * admin. There is no portal database, so the Factor and Driver views read FactorCloud only.
 */
export function pilotAdminViews(): boolean {
  return adminViewsEnabled() && !databaseAuthEnabled();
}

/**
 * Who may use the Driver view on real data when admin views are on (NEXT_PUBLIC_ADMIN_VIEWS=true):
 * with the shared password, whoever holds it; with database sign-in, signed-in factor staff.
 */
export async function adminDriverViewAllowed(): Promise<boolean> {
  if (databaseAuthEnabled() && (await currentValidPortalSession())?.role === 'DRIVER') return true;
  if (!adminViewsEnabled()) return false;
  if (!databaseAuthEnabled()) return true;
  const session = await currentValidPortalSession();
  return Boolean(session && session.role !== 'CLIENT_USER');
}

const PILOT_ADMIN_SESSION: PortalSession = {
  v: 1,
  userId: 'pilot-admin',
  email: 'admin@shared-password',
  displayName: 'Admin',
  role: 'FACTOR_ADMIN',
  factorId: 'pilot',
  clients: [],
  exp: Number.MAX_SAFE_INTEGER,
};

/**
 * Factor staff only. Fails closed: without database authentication there are no roles, so no
 * access, unless admin views were switched on for a shared-password test environment.
 */
export async function requireFactorSession(): Promise<PortalSession> {
  if (await demoRequest()) return DEMO_SESSION;
  if (pilotAdminViews()) return PILOT_ADMIN_SESSION;
  if (!databaseAuthEnabled()) throw new PortalAccessError('Factor operations require database authentication.', 404);
  const session = await requirePortalSession();
  if (session.role === 'CLIENT_USER' || session.role === 'DRIVER') throw new PortalAccessError('Factor access required.', 403);
  return session;
}

export async function resolveConfiguredClientId(): Promise<string> {
  if (await demoRequest()) return DEMO_CLIENT_ID;
  const configured = process.env.FACTORCLOUD_CLIENT_ID;
  if (!databaseAuthEnabled()) {
    if (!configured) throw new PortalAccessError('FACTORCLOUD_CLIENT_ID is not configured.', 500);
    return configured;
  }

  const session = await requirePortalSession();
  if (session.role !== 'CLIENT_USER' && session.role !== 'DRIVER') {
    if (!configured) throw new PortalAccessError('Client portal preview is not configured.', 403);
    return configured;
  }
  if (session.clients.length !== 1) throw new PortalAccessError('This client portal requires exactly one assigned client.', 403);
  const clientId = session.clients[0].factorCloudClientId;
  if (configured && configured !== clientId) throw new PortalAccessError('This login is not assigned to this client portal.', 403);
  return clientId;
}

export async function findLoginUser(email: string): Promise<UserRow | null> {
  const factorCloudFactorId = process.env.FACTORCLOUD_FACTOR_ID;
  if (!factorCloudFactorId) throw new Error('FACTORCLOUD_FACTOR_ID is not configured.');
  const rows = await query<UserRow>(`
    select u.id, u.factor_id, u.email, u.display_name, u.role, u.is_active, u.password_hash
    from portal_users u
    join factors f on f.id = u.factor_id
    where f.factorcloud_factor_id = $1 and lower(u.email) = lower($2)
    limit 1
  `, [factorCloudFactorId, email.trim()]);
  return rows[0] ?? null;
}

export async function userClients(userId: string): Promise<ClientRow[]> {
  return query<ClientRow>(`
    select c.id, c.factorcloud_client_id, c.name
    from user_client_access a
    join portal_clients c on c.id = a.client_id
    where a.user_id = $1 and c.is_active = true
    order by c.name
  `, [userId]);
}

export async function touchLogin(userId: string): Promise<void> {
  await query('update portal_users set last_login_at = now(), updated_at = now() where id = $1', [userId]);
}

export async function portalClientRecord(factorId: string, factorCloudClientId: string): Promise<{ id: string; name: string } | null> {
  const rows = await query<{ id: string; name: string }>(`
    select id, name from portal_clients
    where factor_id = $1 and factorcloud_client_id = $2 and is_active = true
    limit 1
  `, [factorId, factorCloudClientId]);
  return rows[0] ?? null;
}

export class PortalAccessError extends PublicError {}

