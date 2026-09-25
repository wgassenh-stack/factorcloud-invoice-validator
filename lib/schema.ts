import { query } from './db';

// Self-provisioning for the database objects added by database/003_security_hardening.sql, so a
// deploy does not depend on someone remembering to run `npm run db:migrate` first.
//
// Checked once per server process. DDL runs only when something is missing, so a database user
// without CREATE/ALTER rights still works once the objects exist (for example after an admin ran the
// migration). Keep these statements identical to the migration file; a unit test compares them.

export const SECURITY_SCHEMA_STATEMENTS = [
  `alter table submissions add column if not exists idempotency_released_at timestamptz`,
  `create table if not exists auth_throttle (
  bucket text primary key,
  failures integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
)`,
  `create index if not exists auth_throttle_updated_idx on auth_throttle (updated_at)`,
];

// Postgres errors raised when two processes create the same object at the same moment.
const ALREADY_EXISTS = new Set(['42P07', '42701', '23505']);

let ensured: Promise<void> | null = null;

export function ensureSecuritySchema(): Promise<void> {
  ensured ??= provision().catch((err) => {
    ensured = null; // retry on the next request instead of caching the failure
    throw err;
  });
  return ensured;
}

async function provision(): Promise<void> {
  const [state] = await query<{ has_throttle: boolean; has_released_at: boolean }>(`
    select to_regclass('auth_throttle') is not null as has_throttle,
      exists (
        select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'submissions' and column_name = 'idempotency_released_at'
      ) as has_released_at
  `);
  if (state?.has_throttle && state.has_released_at) return;

  for (const statement of SECURITY_SCHEMA_STATEMENTS) {
    try {
      await query(statement);
    } catch (err) {
      if (!ALREADY_EXISTS.has((err as { code?: string }).code ?? '')) {
        throw new Error(`Could not create the portal security tables automatically (the database user may lack CREATE/ALTER rights). Run \`npm run db:migrate\` once. Cause: ${(err as Error).message}`);
      }
    }
  }
}
