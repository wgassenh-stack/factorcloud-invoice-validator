-- The FactorCloud access token a factor admin connected from the portal (Diagnostics → Reconnect),
-- encrypted with a key derived from the server's secret. Replaces copying a token into the
-- deployment settings by hand. One row per FactorCloud factor this deployment serves.
create table if not exists factorcloud_connection (
  factorcloud_factor_id text primary key,
  token_ciphertext text not null,
  expires_at timestamptz,
  connected_by_user_id text references portal_users(id),
  connected_by_name text,
  connected_at timestamptz not null default now()
);
