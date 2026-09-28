// The Factor and Driver views on real data without the portal database (shared-password
// deployments with NEXT_PUBLIC_ADMIN_VIEWS=true). Everything comes from FactorCloud's invoices and
// the note the portal writes on each one. Pure, so it can be tested and used anywhere.

import { isClosedOut, lifecycleStage } from './analytics';
import { driverStatus, sortForDriver, type DriverStatus } from './driver-status';
import { readPortalNote } from './portal-notes';
import type { RiskInvoiceRecord } from './risk';

/** When FactorCloud recorded the invoice (date, or date and time), falling back to its date. */
export function sentAt(record: Pick<RiskInvoiceRecord, 'createdOn' | 'invoiceDate'>): string {
  return String(record.createdOn ?? record.invoiceDate ?? '');
}

/** Flagged by the portal and not yet approved, funded, paid or turned down in FactorCloud. */
export function awaitingFactor(record: RiskInvoiceRecord): boolean {
  return readPortalNote(record.notes).flagged && lifecycleStage(record) === 'SUBMITTED' && !isClosedOut(record);
}

/** Flagged invoices still waiting on the factor, oldest first. */
export function flaggedForReview(records: RiskInvoiceRecord[]): RiskInvoiceRecord[] {
  return records.filter(awaitingFactor).sort((a, b) => sentAt(a).localeCompare(sentAt(b)));
}

/** Clean invoices the portal sent into FactorCloud on `today` (YYYY-MM-DD), newest first. */
export function cleanArrivals(records: RiskInvoiceRecord[], today: string): RiskInvoiceRecord[] {
  return records
    .filter((record) => {
      const note = readPortalNote(record.notes);
      return note.viaPortal && !note.flagged && sentAt(record).startsWith(today);
    })
    .sort((a, b) => sentAt(b).localeCompare(sentAt(a)));
}

/** What the portal database knows about an invoice, when there is one (database sign-in). */
export interface PortalState {
  review?: 'OPEN' | 'APPROVED' | 'REJECTED' | null;
  rejectionNote?: string | null;
  openFix?: string | null;
  fixAnswered?: boolean;
  taskId?: string | null;
}

export interface PilotDriverRow {
  id: string;
  invoiceNumber: string;
  referenceNumber: string;
  debtorId: string | null;
  invoiceAmount: number;
  invoiceDate: string;
  sentAt: string;
  status: DriverStatus;
  taskId: string | null;
}

/**
 * What the Driver view lists: invoices sent from it, the last 60 days plus anything that needs the
 * driver. With the portal database, its review decisions and fix requests (`portal`, by invoice id)
 * take the place of what the FactorCloud note implies.
 */
export function driverRows(records: RiskInvoiceRecord[], clientId: string, today: string, portal: Record<string, PortalState> = {}): PilotDriverRow[] {
  const since = Date.parse(`${today}T00:00:00Z`) - 60 * 86_400_000;
  const rows = records
    .filter((record) => record.companyClientId === clientId && readPortalNote(record.notes).sentBy === 'Driver')
    .map((record): PilotDriverRow => ({
      id: record.id,
      invoiceNumber: record.invoiceNumber ?? '',
      referenceNumber: record.referenceNumber ?? '',
      debtorId: record.companyDebtorId,
      invoiceAmount: record.invoiceAmount ?? 0,
      invoiceDate: (record.invoiceDate ?? '').slice(0, 10),
      sentAt: sentAt(record),
      status: portal[record.id]
        ? driverStatus({ record, ...portal[record.id] })
        : driverStatus({ record, review: awaitingFactor(record) ? 'OPEN' : null }),
      taskId: portal[record.id]?.taskId ?? null,
    }))
    .filter((row) => row.status.needsYou || !row.sentAt || Date.parse(row.sentAt.slice(0, 10)) >= since);
  return sortForDriver(rows).slice(0, 40);
}
