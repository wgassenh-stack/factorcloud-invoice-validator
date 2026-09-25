import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { pool } from '../../../../lib/db';

export const runtime = 'nodejs';
export const maxDuration = 60;

const schemaSql = `
create table if not exists factors (
  id text primary key,
  factorcloud_factor_id text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists portal_clients (
  id text primary key,
  factor_id text not null references factors(id),
  factorcloud_client_id text not null,
  name text not null,
  short_name text,
  is_active boolean not null default true,
  feature_invoices boolean not null default true,
  feature_submit boolean not null default true,
  feature_batch boolean not null default false,
  feature_alerts boolean not null default false,
  concentration_review_pct numeric(6,3) not null default 30,
  concentration_high_pct numeric(6,3) not null default 50,
  volume_spike_ratio numeric(8,3) not null default 1.5,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (factor_id, factorcloud_client_id)
);

create table if not exists portal_users (
  id text primary key,
  factor_id text not null references factors(id),
  email text not null,
  display_name text,
  role text not null check (role in ('FACTOR_ADMIN', 'FACTOR_REVIEWER', 'CLIENT_USER')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (factor_id, email)
);

create table if not exists user_client_access (
  user_id text not null references portal_users(id) on delete cascade,
  client_id text not null references portal_clients(id) on delete cascade,
  primary key (user_id, client_id)
);

create table if not exists submissions (
  id text primary key,
  factor_id text not null references factors(id),
  client_id text not null references portal_clients(id),
  submitted_by_user_id text references portal_users(id),
  factorcloud_invoice_id text,
  invoice_number_original text,
  invoice_number_submitted text,
  reference_number_original text,
  reference_number_submitted text,
  debtor_factorcloud_id text,
  invoice_amount_original numeric(18,2),
  invoice_amount_submitted numeric(18,2),
  invoice_date_original date,
  invoice_date_submitted date,
  validation_status text not null check (validation_status in ('PASS', 'REVIEW', 'FAIL')),
  workflow_status text not null default 'SUBMITTED' check (workflow_status in ('DRAFT', 'SUBMITTED', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED', 'CREATED_IN_FACTORCLOUD', 'ERROR')),
  analysis_receipt text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists submissions_client_created_idx on submissions (client_id, created_at desc);
create index if not exists submissions_review_idx on submissions (factor_id, workflow_status, created_at desc);
create index if not exists submissions_fc_invoice_idx on submissions (factorcloud_invoice_id);

create table if not exists submission_files (
  id text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  original_file_name text not null,
  source_index integer not null,
  sha256 text not null,
  document_type text,
  file_size_bytes bigint,
  created_at timestamptz not null default now(),
  unique (submission_id, source_index),
  unique (submission_id, sha256)
);

create table if not exists review_items (
  id text primary key,
  submission_id text not null references submissions(id) on delete cascade,
  status text not null default 'OPEN' check (status in ('OPEN', 'APPROVED', 'REJECTED', 'RESOLVED')),
  reason text not null,
  assigned_to_user_id text references portal_users(id),
  decided_by_user_id text references portal_users(id),
  decision_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists review_items_open_idx on review_items (status, created_at desc);

create table if not exists audit_events (
  id text primary key,
  factor_id text not null references factors(id),
  client_id text references portal_clients(id),
  submission_id text references submissions(id),
  actor_user_id text references portal_users(id),
  event_type text not null,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_submission_idx on audit_events (submission_id, created_at);
create index if not exists audit_events_client_idx on audit_events (client_id, created_at desc);

alter table portal_users add column if not exists password_hash text;
alter table portal_users add column if not exists last_login_at timestamptz;
create unique index if not exists portal_users_factor_email_lower_idx on portal_users (factor_id, lower(email));
`;

export async function POST() {
  if (process.env.PORTAL_AUTH_MODE === 'database') {
    return NextResponse.json({ error: 'Bootstrap is disabled after database authentication is enabled.' }, { status: 409 });
  }

  const required = ['DATABASE_URL', 'FACTORCLOUD_FACTOR_ID', 'FACTORCLOUD_CLIENT_ID', 'DEV_FACTOR_ADMIN_PASSWORD', 'DEV_CLIENT_USER_PASSWORD'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) return NextResponse.json({ error: `Missing environment variables: ${missing.join(', ')}` }, { status: 500 });

  const factorName = process.env.PORTAL_FACTOR_NAME || 'FactorCloud Sandbox';
  const clientName = process.env.NEXT_PUBLIC_PORTAL_CLIENT_NAME || "Will's Test Trucking LLC";
  const clientShortName = process.env.NEXT_PUBLIC_PORTAL_CLIENT_SHORT_NAME || "Will's Test Trucking";
  const adminEmail = (process.env.DEV_FACTOR_ADMIN_EMAIL || 'factor-admin@factorcloud.local').toLowerCase();
  const clientEmail = (process.env.DEV_CLIENT_USER_EMAIL || 'client@willstesttrucking.local').toLowerCase();
  const adminName = process.env.DEV_FACTOR_ADMIN_NAME || 'Factor Admin';
  const clientUserName = process.env.DEV_CLIENT_USER_NAME || "Will's Test Trucking User";

  const db = await pool().connect();
  try {
    await db.query('begin');
    await db.query(schemaSql);

    const factorResult = await db.query(
      `insert into factors (id, factorcloud_factor_id, name)
       values ($1,$2,$3)
       on conflict (factorcloud_factor_id) do update set name=excluded.name
       returning id`,
      [`factor_${crypto.randomUUID()}`, process.env.FACTORCLOUD_FACTOR_ID, factorName],
    );
    const factorId = factorResult.rows[0].id as string;

    const clientResult = await db.query(
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
    const clientId = clientResult.rows[0].id as string;

    const adminId = await upsertUser(db, {
      factorId,
      email: adminEmail,
      password: process.env.DEV_FACTOR_ADMIN_PASSWORD!,
      name: adminName,
      role: 'FACTOR_ADMIN',
    });
    const clientUserId = await upsertUser(db, {
      factorId,
      email: clientEmail,
      password: process.env.DEV_CLIENT_USER_PASSWORD!,
      name: clientUserName,
      role: 'CLIENT_USER',
    });

    await db.query(
      'insert into user_client_access (user_id, client_id) values ($1,$2) on conflict do nothing',
      [clientUserId, clientId],
    );

    await db.query('commit');

    const counts = await db.query(`select
      (select count(*)::int from factors) as factors,
      (select count(*)::int from portal_clients) as clients,
      (select count(*)::int from portal_users) as users`);

    return NextResponse.json({
      ok: true,
      message: 'Database initialized successfully.',
      factor: factorName,
      client: clientName,
      users: [
        { email: adminEmail, role: 'FACTOR_ADMIN' },
        { email: clientEmail, role: 'CLIENT_USER' },
      ],
      counts: counts.rows[0],
    });
  } catch (error) {
    await db.query('rollback');
    console.error('Database bootstrap failed', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Database bootstrap failed.' }, { status: 500 });
  } finally {
    db.release();
  }
}

async function upsertUser(
  db: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  input: { factorId: string; email: string; password: string; name: string; role: 'FACTOR_ADMIN' | 'CLIENT_USER' },
) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  const existing = await db.query(
    'select id from portal_users where factor_id=$1 and lower(email)=lower($2) limit 1',
    [input.factorId, input.email],
  );
  const id = (existing.rows[0]?.id as string | undefined) || `user_${crypto.randomUUID()}`;
  if (existing.rows[0]) {
    await db.query(
      `update portal_users
       set display_name=$1, role=$2, password_hash=$3, is_active=true, updated_at=now()
       where id=$4`,
      [input.name, input.role, passwordHash, id],
    );
  } else {
    await db.query(
      `insert into portal_users (id, factor_id, email, display_name, role, password_hash)
       values ($1,$2,$3,$4,$5,$6)`,
      [id, input.factorId, input.email, input.name, input.role, passwordHash],
    );
  }
  return id;
}
