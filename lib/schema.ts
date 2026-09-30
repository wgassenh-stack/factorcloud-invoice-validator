import { query } from './db';

// Self-provisioning for the database objects added by database/003_security_hardening.sql,
// database/004_client_tasks.sql and database/005_funding_engine.sql, so a deploy does not depend on someone remembering to run
// `npm run db:migrate` first.
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

export const WORKFLOW_SCHEMA_STATEMENTS = [
  `create table if not exists client_tasks (
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
)`,
  `create index if not exists client_tasks_client_open_idx on client_tasks (client_id, status, created_at desc)`,
];

export const ENGINE_SCHEMA_STATEMENTS = [
  `create table if not exists rule_settings (
  factor_id text primary key references factors(id),
  settings jsonb not null,
  updated_by_user_id text references portal_users(id),
  updated_at timestamptz not null default now()
)`,
  `create table if not exists engine_runs (
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
  state text not null check (state in ('SUGGESTED', 'REVIEW', 'APPROVED', 'FUNDING', 'FUNDED', 'FAILED', 'CLOSED')),
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
)`,
  `create index if not exists engine_runs_factor_idx on engine_runs (factor_id, created_at desc)`,
  `create index if not exists engine_runs_funded_idx on engine_runs (factor_id, auto_funded, funded_at)`,
];

// Postgres errors raised when two processes create the same object at the same moment.
const ALREADY_EXISTS = new Set(['42P07', '42701', '23505']);

let ensured: Promise<void> | null = null;
let workflowEnsured: Promise<void> | null = null;
let engineEnsured: Promise<void> | null = null;

export function ensureSecuritySchema(): Promise<void> {
  ensured ??= provision().catch((err) => {
    ensured = null; // retry on the next request instead of caching the failure
    throw err;
  });
  return ensured;
}

export function ensureWorkflowSchema(): Promise<void> {
  workflowEnsured ??= provisionWorkflow().catch((err) => {
    workflowEnsured = null;
    throw err;
  });
  return workflowEnsured;
}

export function ensureEngineSchema(): Promise<void> {
  engineEnsured ??= provisionEngine().catch((err) => {
    engineEnsured = null;
    throw err;
  });
  return engineEnsured;
}

async function provisionEngine(): Promise<void> {
  const [state] = await query<{ ready: boolean }>(`select to_regclass('engine_runs') is not null and to_regclass('rule_settings') is not null as ready`);
  if (state?.ready) return;
  await runStatements(ENGINE_SCHEMA_STATEMENTS, 'funding engine');
}

async function provisionWorkflow(): Promise<void> {
  const [state] = await query<{ ready: boolean }>(`select to_regclass('client_tasks') is not null as ready`);
  if (state?.ready) return;
  await runStatements(WORKFLOW_SCHEMA_STATEMENTS, 'client task');
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

  await runStatements(SECURITY_SCHEMA_STATEMENTS, 'security');
}

async function runStatements(statements: string[], label: string): Promise<void> {
  for (const statement of statements) {
    try {
      await query(statement);
    } catch (err) {
      if (!ALREADY_EXISTS.has((err as { code?: string }).code ?? '')) {
        throw new Error(`Could not create the portal ${label} tables automatically (the database user may lack CREATE/ALTER rights). Run \`npm run db:migrate\` once. Cause: ${(err as Error).message}`);
      }
    }
  }
}
