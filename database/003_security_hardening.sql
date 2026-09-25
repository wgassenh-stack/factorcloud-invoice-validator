-- Security hardening. Idempotent, like the other migration files.

-- Set when a submission's idempotency key was released because FactorCloud definitively refused
-- the create (no invoice exists), so the same invoice may be submitted again.
alter table submissions add column if not exists idempotency_released_at timestamptz;

-- Login throttling. One row per bucket: a hashed email ("email:<sha256>") or a client IP ("ip:<ip>").
create table if not exists auth_throttle (
  bucket text primary key,
  failures integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists auth_throttle_updated_idx on auth_throttle (updated_at);
