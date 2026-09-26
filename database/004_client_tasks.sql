-- Client tasks ("request a fix") and a notification log. Idempotent, like the other migration files.
-- The app also creates these objects itself on first use (lib/schema.ts), so running this file is
-- optional. Keep the two in sync; lib/security-hardening.test.ts checks that they match.

-- A factor reviewer asks the client to fix a submission (for example: upload the signed POD).
create table if not exists client_tasks (
  id text primary key,
  factor_id text not null references factors(id),
  client_id text not null references portal_clients(id),
  submission_id text not null references submissions(id) on delete cascade,
  review_id text references review_items(id),
  kind text not null default 'FIX_REQUESTED',
  message text not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'DONE', 'CANCELED')),
  requested_by_user_id text references portal_users(id),
  resolved_by_user_id text references portal_users(id),
  response_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists client_tasks_client_open_idx on client_tasks (client_id, status, created_at desc);

-- One row per email sent for a submission event, so progress emails (funded, paid) go out once.
create table if not exists notification_log (
  submission_id text not null references submissions(id) on delete cascade,
  event text not null,
  recipient text not null,
  sent_at timestamptz not null default now(),
  primary key (submission_id, event, recipient)
);
