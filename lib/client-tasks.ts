import 'server-only';

import { query } from './db';
import { ensureWorkflowSchema } from './schema';

// "Request a fix": a factor reviewer asks the client for something (a signed POD, a corrected
// load number) instead of rejecting. The client answers by uploading files to the same
// submission, and the review item stays open for the reviewer's decision.

export interface ClientTask {
  id: string;
  submissionId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  message: string;
  status: 'OPEN' | 'DONE' | 'CANCELED';
  createdAt: string;
  resolvedAt: string | null;
  responseNote: string | null;
}

type TaskRow = {
  id: string;
  submission_id: string;
  factorcloud_invoice_id: string | null;
  invoice_number_submitted: string | null;
  message: string;
  status: ClientTask['status'];
  created_at: Date | string;
  resolved_at: Date | string | null;
  response_note: string | null;
};

const iso = (value: Date | string | null) => (value == null ? null : new Date(value).toISOString());

function toTask(row: TaskRow): ClientTask {
  return {
    id: row.id,
    submissionId: row.submission_id,
    invoiceId: row.factorcloud_invoice_id,
    invoiceNumber: row.invoice_number_submitted,
    message: row.message,
    status: row.status,
    createdAt: iso(row.created_at)!,
    resolvedAt: iso(row.resolved_at),
    responseNote: row.response_note,
  };
}

const TASK_SELECT = `
  select t.id, t.submission_id, s.factorcloud_invoice_id, s.invoice_number_submitted, t.message, t.status,
    t.created_at, t.resolved_at, t.response_note
  from client_tasks t
  join submissions s on s.id = t.submission_id
  join portal_clients c on c.id = t.client_id`;

/** A client's tasks, newest first. */
export async function listClientTasks(factorId: string, factorCloudClientId: string, status: ClientTask['status'] = 'OPEN'): Promise<ClientTask[]> {
  await ensureWorkflowSchema();
  const rows = await query<TaskRow>(`${TASK_SELECT}
    where t.factor_id = $1 and c.factorcloud_client_id = $2 and t.status = $3
    order by t.created_at desc limit 50`, [factorId, factorCloudClientId, status]);
  return rows.map(toTask);
}

/** One task, only if it belongs to this client. */
export async function clientTask(taskId: string, factorId: string, factorCloudClientId: string): Promise<(ClientTask & { clientRowId: string }) | null> {
  await ensureWorkflowSchema();
  const rows = await query<TaskRow & { client_id: string }>(`${TASK_SELECT.replace('select t.id,', 'select t.client_id, t.id,')}
    where t.id = $1 and t.factor_id = $2 and c.factorcloud_client_id = $3`, [taskId, factorId, factorCloudClientId]);
  return rows[0] ? { ...toTask(rows[0]), clientRowId: rows[0].client_id } : null;
}

/** The latest task per submission, for the review queue. */
export async function latestTasksBySubmission(submissionIds: string[]): Promise<Record<string, ClientTask>> {
  if (!submissionIds.length) return {};
  await ensureWorkflowSchema();
  const rows = await query<TaskRow>(`
    select distinct on (t.submission_id) t.id, t.submission_id, s.factorcloud_invoice_id, s.invoice_number_submitted,
      t.message, t.status, t.created_at, t.resolved_at, t.response_note
    from client_tasks t
    join submissions s on s.id = t.submission_id
    where t.submission_id = any($1::text[]) and t.status <> 'CANCELED'
    order by t.submission_id, t.created_at desc`, [submissionIds]);
  return Object.fromEntries(rows.map((row) => [row.submission_id, toTask(row)]));
}

/** Email of the portal user who submitted a submission, if known. */
export async function submitterEmail(submissionId: string): Promise<string | null> {
  const rows = await query<{ email: string | null }>(`
    select u.email from submissions s join portal_users u on u.id = s.submitted_by_user_id where s.id = $1`, [submissionId]);
  return rows[0]?.email ?? null;
}
