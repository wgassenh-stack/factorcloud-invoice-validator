import crypto from 'node:crypto';
import process from 'node:process';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const required = ['DATABASE_URL', 'FACTORCLOUD_FACTOR_ID', 'FACTORCLOUD_CLIENT_ID'];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required.`);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const factorName = process.env.PORTAL_FACTOR_NAME || 'FactorCloud Sandbox';
const clientName = process.env.NEXT_PUBLIC_PORTAL_CLIENT_NAME || "Will's Test Trucking LLC";
const clientShortName = process.env.NEXT_PUBLIC_PORTAL_CLIENT_SHORT_NAME || "Will's Test Trucking";
const adminEmail = (process.env.DEV_FACTOR_ADMIN_EMAIL || 'factor-admin@factorcloud.local').toLowerCase();
const clientEmail = (process.env.DEV_CLIENT_USER_EMAIL || 'client@willstesttrucking.local').toLowerCase();
const adminPassword = process.env.DEV_FACTOR_ADMIN_PASSWORD || randomPassword();
const clientPassword = process.env.DEV_CLIENT_USER_PASSWORD || randomPassword();
const adminName = process.env.DEV_FACTOR_ADMIN_NAME || 'Factor Admin';
const clientUserName = process.env.DEV_CLIENT_USER_NAME || "Will's Test Trucking User";

const db = await pool.connect();
try {
  await db.query('begin');

  const factorResult = await db.query(
    `insert into factors (id, factorcloud_factor_id, name)
     values ($1,$2,$3)
     on conflict (factorcloud_factor_id) do update set name=excluded.name
     returning id`,
    [`factor_${crypto.randomUUID()}`, process.env.FACTORCLOUD_FACTOR_ID, factorName],
  );
  const factorId = factorResult.rows[0].id;

  const portalClientResult = await db.query(
    `insert into portal_clients (
       id, factor_id, factorcloud_client_id, name, short_name,
       feature_invoices, feature_submit, feature_batch, feature_alerts
     ) values ($1,$2,$3,$4,$5,true,true,true,true)
     on conflict (factor_id, factorcloud_client_id) do update set
       name=excluded.name,
       short_name=excluded.short_name,
       is_active=true,
       feature_invoices=true,
       feature_submit=true,
       feature_batch=true,
       feature_alerts=true,
       updated_at=now()
     returning id`,
    [`client_${crypto.randomUUID()}`, factorId, process.env.FACTORCLOUD_CLIENT_ID, clientName, clientShortName],
  );
  const portalClientId = portalClientResult.rows[0].id;

  const adminId = await upsertUser({ factorId, email: adminEmail, password: adminPassword, name: adminName, role: 'FACTOR_ADMIN' });
  const clientUserId = await upsertUser({ factorId, email: clientEmail, password: clientPassword, name: clientUserName, role: 'CLIENT_USER' });

  await db.query(
    'insert into user_client_access (user_id, client_id) values ($1,$2) on conflict do nothing',
    [clientUserId, portalClientId],
  );

  await db.query('commit');

  console.log('\nDevelopment portal bootstrap complete.');
  console.log(`Factor admin: ${adminEmail}`);
  console.log(`Factor admin password: ${adminPassword}`);
  console.log(`Client user: ${clientEmail}`);
  console.log(`Client user password: ${clientPassword}`);
  console.log('\nStore these credentials somewhere safe. Generated passwords are only printed during this run.');

  async function upsertUser({ factorId: currentFactorId, email, password, name, role }) {
    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await db.query(
      'select id from portal_users where factor_id=$1 and lower(email)=lower($2) limit 1',
      [currentFactorId, email],
    );
    const id = existing.rows[0]?.id || `user_${crypto.randomUUID()}`;
    if (existing.rows[0]) {
      await db.query(
        `update portal_users
         set display_name=$1, role=$2, password_hash=$3, is_active=true, updated_at=now()
         where id=$4`,
        [name, role, passwordHash, id],
      );
    } else {
      await db.query(
        `insert into portal_users (id, factor_id, email, display_name, role, password_hash)
         values ($1,$2,$3,$4,$5,$6)`,
        [id, currentFactorId, email, name, role, passwordHash],
      );
    }
    return id;
  }
} catch (error) {
  await db.query('rollback');
  throw error;
} finally {
  db.release();
  await pool.end();
}

function randomPassword() {
  return crypto.randomBytes(18).toString('base64url');
}
