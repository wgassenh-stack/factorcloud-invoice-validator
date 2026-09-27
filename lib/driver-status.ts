// What a driver sees for each invoice they sent in: a few plain words instead of FactorCloud's
// status fields, with anything that needs them first. Pure, so it can be tested and used anywhere.

import { lifecycleStage } from './analytics';
import type { RiskInvoiceRecord } from './risk';

export type DriverStatusKey = 'FIX' | 'REJECTED' | 'CANCELED' | 'CHECKING' | 'SENT' | 'APPROVED' | 'FUNDED' | 'PAID';

export interface DriverStatus {
  key: DriverStatusKey;
  label: string;
  detail: string;
  /** Whether the driver has to do something. */
  needsYou: boolean;
}

export interface DriverStatusInput {
  record: Pick<RiskInvoiceRecord, 'status' | 'verificationStatus' | 'paymentStatus' | 'fundedDate' | 'paidDate'>;
  review?: 'OPEN' | 'APPROVED' | 'REJECTED' | null;
  /** The factor's open fix request, if any. */
  openFix?: string | null;
  /** The driver already answered a fix request on this invoice. */
  fixAnswered?: boolean;
  rejectionNote?: string | null;
}

const token = (value: string | null | undefined) => (value ?? '').trim().toUpperCase();

export function driverStatus({ record, review, openFix, fixAnswered, rejectionNote }: DriverStatusInput): DriverStatus {
  if (openFix) return { key: 'FIX', label: 'Needs a fix', detail: openFix, needsYou: true };
  if (review === 'REJECTED' || token(record.status) === 'REJECTED') {
    return { key: 'REJECTED', label: 'Rejected', detail: rejectionNote || 'Your factor rejected this invoice. Send it again with the right paperwork.', needsYou: true };
  }
  if (['CANCELED', 'CANCELLED', 'VOID'].includes(token(record.status))) return { key: 'CANCELED', label: 'Canceled', detail: 'This invoice was canceled.', needsYou: false };
  const stage = lifecycleStage(record as RiskInvoiceRecord);
  if (stage === 'PAID') return { key: 'PAID', label: 'Paid', detail: 'The customer paid this invoice.', needsYou: false };
  if (stage === 'FUNDED') return { key: 'FUNDED', label: 'Funded', detail: 'Approved and paid out to your company.', needsYou: false };
  if (review === 'OPEN') {
    return { key: 'CHECKING', label: 'Being checked', detail: fixAnswered ? 'You sent the fix. Your factor is checking it.' : 'Your factor is checking this before funding.', needsYou: false };
  }
  if (stage === 'VERIFIED') return { key: 'APPROVED', label: 'Approved', detail: 'Approved. Funding is on the way.', needsYou: false };
  return { key: 'SENT', label: 'Sent', detail: 'Received. Waiting for your factor.', needsYou: false };
}

/** Anything needing the driver first, then newest first. */
export function sortForDriver<T extends { status: DriverStatus; invoiceDate: string | null; sentAt?: string | null }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => Number(b.status.needsYou) - Number(a.status.needsYou)
    || String(b.sentAt ?? b.invoiceDate ?? '').localeCompare(String(a.sentAt ?? a.invoiceDate ?? '')));
}
