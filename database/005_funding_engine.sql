-- Funding engine: the factor's rule settings, and what the engine decided and did for each invoice.
-- Idempotent. The app also creates these objects itself on first use (lib/schema.ts); keep the two
-- in sync, lib/security-hardening.test.ts checks that they match.

create table if not exists rule_settings (
  factor_id text primary key references factors(id),
  settings jsonb not null,
  updated_by_user_id text references portal_users(id),
  updated_at timestamptz not null default now()
);

create table if not exists engine_runs (
  id text primary key,
  factor_id text not null references factors(id),
  client_id text not null references portal_clients(id),
  submission_id text references submissions(id) on delete set null,
  factorcloud_invoice_id text not null,
  factorcloud_client_id text not null,
  invoice_number text,
  amount numeric(14,2) not null,
  mode text not null check (mode in ('suggest', 'approve', 'fund')),
  outcome text not null check (outcome in ('FUND', 'HOLD', 'REVIEW')),
  state text not null check (state in ('SUGGESTED', 'REVIEW', 'APPROVED', 'FUNDING', 'FUNDED', 'FAILED')),
  rules jsonb not null,
  reasons jsonb not null,
  detail text,
  invoice_group_id text,
  payment_type text,
  auto_funded boolean not null default false,
  funded_at timestamptz,
  funded_by_user_id text references portal_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists engine_runs_factor_idx on engine_runs (factor_id, created_at desc);

create index if not exists engine_runs_funded_idx on engine_runs (factor_id, auto_funded, funded_at);
