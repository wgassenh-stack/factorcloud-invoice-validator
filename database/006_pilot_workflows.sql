-- Run with the migration user before deploying. Runtime users need no DDL privileges.
alter table portal_users drop constraint if exists portal_users_role_check;
alter table portal_users add constraint portal_users_role_check check (role in ('FACTOR_ADMIN','FACTOR_REVIEWER','CLIENT_USER','DRIVER'));

create table if not exists funding_reservations (
  run_id text primary key references engine_runs(id),
  factor_id text not null references factors(id),
  client_id text not null,
  business_day date not null,
  amount numeric(14,2) not null,
  status text not null check (status in ('RESERVED','CONFIRMED','UNKNOWN','RELEASED')),
  created_at timestamptz not null default now()
);
create index if not exists funding_reservations_budget_idx on funding_reservations(factor_id,business_day,status);

create table if not exists recovery_items (
  id text primary key,
  factor_id text not null references factors(id),
  submission_id text references submissions(id),
  run_id text references engine_runs(id),
  kind text not null,
  detail text not null,
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED')),
  resolution text,
  resolved_by text references portal_users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists recovery_items_factor_idx on recovery_items(factor_id,status,created_at);

create table if not exists rule_versions (
  id bigserial primary key,
  factor_id text not null references factors(id),
  settings jsonb not null,
  actor_id text references portal_users(id),
  created_at timestamptz not null default now()
);
alter table engine_runs add column if not exists settings_snapshot jsonb;
alter table engine_runs add column if not exists facts_snapshot jsonb;

create table if not exists driver_invites (
  token_hash text primary key,
  factor_id text not null references factors(id),
  client_id text not null references portal_clients(id),
  email text not null,
  created_by text not null references portal_users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists notification_outbox (
  id text primary key,
  factor_id text not null references factors(id),
  task_id text references client_tasks(id),
  recipient text not null,
  subject text not null,
  message text not null,
  dedupe_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','FAILED','CANCELED')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
