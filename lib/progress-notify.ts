import 'server-only';

import { lifecycleStage } from './analytics';
import { query } from './db';
import { emailConfigured, emails, sendEmail } from './notify';
import type { RiskInvoiceRecord } from './risk';
import { ensureWorkflowSchema } from './schema';
import { databaseAuthEnabled } from './session';

// "Your invoice was funded" / "was paid" emails for invoices submitted through the portal.
// FactorCloud has no webhooks, so this runs whenever fresh invoice data is loaded (dashboards) and
// from the daily cron route. notification_log makes each email go out once. Only recent events
// (the last RECENT_DAYS days) are announced, so switching email on later doesn't email old history.

const RECENT_DAYS = 7;
const MAX_PER_RUN = 25;

type Row = { id: string; factorcloud_invoice_id: string; invoice_number_submitted: string | null; email: string };

export async function notifyInvoiceProgress(records: RiskInvoiceRecord[], debtorNames: Record<string, string> = {}): Promise<number> {
  if (!databaseAuthEnabled() || !emailConfigured()) return 0;
  const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
  const recent = (value: string | null | undefined) => Boolean(value && Date.parse(`${value.slice(0, 10)}T00:00:00Z`) >= cutoff);
  const events = records.flatMap((record): { record: RiskInvoiceRecord; event: 'INVOICE_FUNDED' | 'INVOICE_PAID' }[] => {
    const stage = lifecycleStage(record);
    if (stage === 'PAID' && recent(record.paidDate)) return [{ record, event: 'INVOICE_PAID' }];
    if (stage === 'FUNDED' && recent(record.fundedDate)) return [{ record, event: 'INVOICE_FUNDED' }];
    return [];
  });
  if (!events.length) return 0;

  await ensureWorkflowSchema();
  const rows = await query<Row>(`
    select s.id, s.factorcloud_invoice_id, s.invoice_number_submitted, u.email
    from submissions s join portal_users u on u.id = s.submitted_by_user_id
    where s.factorcloud_invoice_id = any($1::text[])
  `, [events.map((e) => e.record.id)]);
  const byInvoice = new Map(rows.map((row) => [row.factorcloud_invoice_id, row]));

  let sent = 0;
  for (const { record, event } of events) {
    if (sent >= MAX_PER_RUN) break;
    const row = byInvoice.get(record.id);
    if (!row?.email) continue;
    // Claim the event first so two dashboards loading at once can't both send it.
    const claimed = await query(`insert into notification_log (submission_id, event, recipient) values ($1,$2,$3) on conflict do nothing returning 1`, [row.id, event, row.email]);
    if (!claimed.length) continue;
    const invoiceNumber = row.invoice_number_submitted ?? record.invoiceNumber ?? record.id;
    const result = await sendEmail(event === 'INVOICE_FUNDED'
      ? emails.invoiceFunded({ to: row.email, invoiceNumber, advance: record.advanceAmount ?? null, invoiceId: record.id })
      : emails.invoicePaid({ to: row.email, invoiceNumber, debtorName: record.companyDebtorId ? debtorNames[record.companyDebtorId] ?? record.companyDebtorName ?? null : null, invoiceId: record.id }));
    if (result === 'sent') sent += 1;
    else await query('delete from notification_log where submission_id=$1 and event=$2 and recipient=$3', [row.id, event, row.email]);
  }
  return sent;
}
