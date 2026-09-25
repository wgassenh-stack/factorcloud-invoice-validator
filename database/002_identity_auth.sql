-- Database-backed portal identity fields.
alter table portal_users add column if not exists password_hash text;
alter table portal_users add column if not exists last_login_at timestamptz;

create unique index if not exists portal_users_factor_email_lower_idx
  on portal_users (factor_id, lower(email));
