import 'server-only';

import { cookies } from 'next/headers';
import { query } from './db';
import { databaseAuthEnabled, PORTAL_SESSION_COOKIE, verifyPortalSession, type PortalRole, type PortalSession } from './session';

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

export async function requirePortalSession(): Promise<PortalSession> {
  const session = await currentPortalSession();
  if (!session) throw new PortalAccessError('Portal authentication required.', 401);
  return session;
}

export async function requireFactorSession(): Promise<PortalSession> {
  const session = await requirePortalSession();
  if (session.role === 'CLIENT_USER') throw new PortalAccessError('Factor access required.', 403);
  return session;
}

export async function resolveConfiguredClientId(): Promise<string> {
  const configured = process.env.FACTORCLOUD_CLIENT_ID;
  if (!databaseAuthEnabled()) {
    if (!configured) throw new PortalAccessError('FACTORCLOUD_CLIENT_ID is not configured.', 500);
    return configured;
  }

  const session = await requirePortalSession();
  if (session.role !== 'CLIENT_USER') {
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

export class PortalAccessError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
