-- FactorCloud portal workflow database, PostgreSQL-compatible.
-- FactorCloud remains the system of record for factoring/accounting records.
-- This database owns portal identity, workflow, review state, integrity metadata, and audit history.

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
