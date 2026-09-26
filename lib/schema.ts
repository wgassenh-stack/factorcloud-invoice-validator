import { query } from './db';

// Self-provisioning for the database objects added by database/003_security_hardening.sql and
// database/004_client_tasks.sql, so a deploy does not depend on someone remembering to run
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
  `create table if not exists notification_log (
  submission_id text not null references submissions(id) on delete cascade,
  event text not null,
  recipient text not null,
  sent_at timestamptz not null default now(),
  primary key (submission_id, event, recipient)
)`,
];

// Postgres errors raised when two processes create the same object at the same moment.
const ALREADY_EXISTS = new Set(['42P07', '42701', '23505']);

let ensured: Promise<void> | null = null;
let workflowEnsured: Promise<void> | null = null;

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

async function provisionWorkflow(): Promise<void> {
  const [state] = await query<{ ready: boolean }>(`select to_regclass('client_tasks') is not null and to_regclass('notification_log') is not null as ready`);
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
