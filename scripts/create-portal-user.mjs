import crypto from 'node:crypto';
import process from 'node:process';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const required = ['DATABASE_URL', 'FACTORCLOUD_FACTOR_ID', 'PORTAL_USER_EMAIL', 'PORTAL_USER_PASSWORD', 'PORTAL_USER_ROLE'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);

const role = process.env.PORTAL_USER_ROLE;
if (!['FACTOR_ADMIN', 'FACTOR_REVIEWER', 'CLIENT_USER'].includes(role)) throw new Error('PORTAL_USER_ROLE must be FACTOR_ADMIN, FACTOR_REVIEWER, or CLIENT_USER.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const factorId = process.env.PORTAL_FACTOR_ID || `factor_${crypto.randomUUID()}`;
const factorName = process.env.PORTAL_FACTOR_NAME || 'FactorCloud factor';
const userId = process.env.PORTAL_USER_ID || `user_${crypto.randomUUID()}`;
const passwordHash = await bcrypt.hash(process.env.PORTAL_USER_PASSWORD, 12);

const client = await pool.connect();
try {
  await client.query('begin');
  const factorRows = await client.query('select id from factors where factorcloud_factor_id = $1 limit 1', [process.env.FACTORCLOUD_FACTOR_ID]);
  const resolvedFactorId = factorRows.rows[0]?.id || factorId;
  if (!factorRows.rows[0]) {
    await client.query('insert into factors (id, factorcloud_factor_id, name) values ($1, $2, $3)', [resolvedFactorId, process.env.FACTORCLOUD_FACTOR_ID, factorName]);
  }

  const existing = await client.query('select id from portal_users where factor_id = $1 and lower(email) = lower($2) limit 1', [resolvedFactorId, process.env.PORTAL_USER_EMAIL]);
  const resolvedUserId = existing.rows[0]?.id || userId;
  if (existing.rows[0]) {
    await client.query('update portal_users set password_hash=$1, role=$2, display_name=$3, is_active=true, updated_at=now() where id=$4', [passwordHash, role, process.env.PORTAL_USER_NAME || null, resolvedUserId]);
  } else {
    await client.query('insert into portal_users (id, factor_id, email, display_name, role, password_hash) values ($1,$2,$3,$4,$5,$6)', [resolvedUserId, resolvedFactorId, process.env.PORTAL_USER_EMAIL, process.env.PORTAL_USER_NAME || null, role, passwordHash]);
  }

  if (role === 'CLIENT_USER') {
    if (!process.env.FACTORCLOUD_CLIENT_ID) throw new Error('FACTORCLOUD_CLIENT_ID is required for CLIENT_USER.');
    const portalClientRows = await client.query('select id from portal_clients where factor_id=$1 and factorcloud_client_id=$2 limit 1', [resolvedFactorId, process.env.FACTORCLOUD_CLIENT_ID]);
    const portalClientId = portalClientRows.rows[0]?.id || `client_${crypto.randomUUID()}`;
    if (!portalClientRows.rows[0]) {
      await client.query(`insert into portal_clients (id, factor_id, factorcloud_client_id, name, short_name, feature_invoices, feature_submit, feature_batch, feature_alerts)
        values ($1,$2,$3,$4,$5,true,true,true,true)`, [portalClientId, resolvedFactorId, process.env.FACTORCLOUD_CLIENT_ID, process.env.NEXT_PUBLIC_PORTAL_CLIENT_NAME || 'Client', process.env.NEXT_PUBLIC_PORTAL_CLIENT_SHORT_NAME || null]);
    }
    await client.query('insert into user_client_access (user_id, client_id) values ($1,$2) on conflict do nothing', [resolvedUserId, portalClientId]);
  }

  await client.query('commit');
  console.log(`Portal user ready: ${process.env.PORTAL_USER_EMAIL} (${role})`);
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
  await pool.end();
}
