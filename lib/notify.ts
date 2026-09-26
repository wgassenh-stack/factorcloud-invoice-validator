import 'server-only';

// Email notifications. Sent through Resend (https://resend.com) when RESEND_API_KEY and
// NOTIFY_FROM are set; otherwise, and always in demo mode, the message is only logged. A failed
// email never fails the action that triggered it.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type SendResult = 'sent' | 'skipped' | 'failed';

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM);
}

export async function sendEmail(message: EmailMessage, opts: { demo?: boolean } = {}): Promise<SendResult> {
  if (!message.to) return 'skipped';
  if (opts.demo || !emailConfigured()) {
    console.info(`[notify] ${opts.demo ? 'demo' : 'email not configured'}: would send "${message.subject}" to ${message.to}`);
    return 'skipped';
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.NOTIFY_FROM, to: [message.to], subject: message.subject, text: message.text }),
    });
    if (!res.ok) {
      console.error(`[notify] Resend refused "${message.subject}" (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error(`[notify] could not send "${message.subject}"`, err);
    return 'failed';
  }
}

/** Absolute link into the portal for emails, when PORTAL_PUBLIC_URL is set. */
export function portalLink(path: string): string {
  const base = (process.env.PORTAL_PUBLIC_URL ?? '').replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

const money = (value: number | null | undefined) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value ?? 0);
const signoff = '\n\n— Sent by your factor\'s client portal. Reply to your factor directly if you have questions.';

export const emails = {
  fixRequested: (a: { to: string; invoiceNumber: string; message: string; invoiceId: string | null }): EmailMessage => ({
    to: a.to,
    subject: `Action needed on invoice ${a.invoiceNumber}`,
    text: `Your factor needs something before invoice ${a.invoiceNumber} can be approved:\n\n"${a.message}"\n\nUpload the fix here: ${portalLink(a.invoiceId ? `/invoices/${encodeURIComponent(a.invoiceId)}` : '/')}${signoff}`,
  }),
  fixSubmitted: (a: { to: string; invoiceNumber: string; clientName: string; fileCount: number; note: string | null; submissionId: string }): EmailMessage => ({
    to: a.to,
    subject: `${a.clientName} sent a fix for invoice ${a.invoiceNumber}`,
    text: `${a.clientName} responded to your fix request on invoice ${a.invoiceNumber} with ${a.fileCount} file${a.fileCount === 1 ? '' : 's'}.${a.note ? `\n\nTheir note: "${a.note}"` : ''}\n\nReview it: ${portalLink(`/ops/submissions/${encodeURIComponent(a.submissionId)}`)}`,
  }),
  reviewDecided: (a: { to: string; invoiceNumber: string; approved: boolean; note: string | null; invoiceId: string | null }): EmailMessage => ({
    to: a.to,
    subject: `Invoice ${a.invoiceNumber} was ${a.approved ? 'approved' : 'rejected'}`,
    text: `Your factor ${a.approved ? 'approved' : 'rejected'} invoice ${a.invoiceNumber}.${a.note ? `\n\nNote: "${a.note}"` : ''}\n\nDetails: ${portalLink(a.invoiceId ? `/invoices/${encodeURIComponent(a.invoiceId)}` : '/')}${signoff}`,
  }),
  invoiceFunded: (a: { to: string; invoiceNumber: string; advance: number | null; invoiceId: string }): EmailMessage => ({
    to: a.to,
    subject: `Invoice ${a.invoiceNumber} was funded`,
    text: `Invoice ${a.invoiceNumber} was funded${a.advance ? `. Your advance: ${money(a.advance)}` : ''}.\n\nDetails: ${portalLink(`/invoices/${encodeURIComponent(a.invoiceId)}`)}${signoff}`,
  }),
  invoicePaid: (a: { to: string; invoiceNumber: string; debtorName: string | null; invoiceId: string }): EmailMessage => ({
    to: a.to,
    subject: `Invoice ${a.invoiceNumber} was paid`,
    text: `${a.debtorName ?? 'The debtor'} paid invoice ${a.invoiceNumber}. Any reserve due on it will be released per your agreement.\n\nDetails: ${portalLink(`/invoices/${encodeURIComponent(a.invoiceId)}`)}${signoff}`,
  }),
};
