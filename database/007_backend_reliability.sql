alter table engine_runs add column if not exists approval_status text not null default 'IDLE'
  check (approval_status in ('IDLE','CHECKING','SENDING','UNKNOWN','COMPLETE'));
alter table engine_runs add column if not exists approval_started_at timestamptz;
alter table engine_runs add column if not exists approval_token uuid;
alter table driver_invites add column if not exists revoked_at timestamptz;
create index if not exists notification_outbox_pending_idx on notification_outbox(factor_id,available_at) where status='PENDING';
