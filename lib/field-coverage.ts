// Which FactorCloud invoice fields actually come back filled in, and which portal features rely on
// them. Pure, so the connection check can be tested without FactorCloud.

import type { RiskInvoiceRecord } from './risk';

export interface FieldCoverage {
  field: keyof RiskInvoiceRecord;
  label: string;
  usedBy: string;
  present: number;
  total: number;
  share: number;
}

export interface ValueCounts {
  field: 'status' | 'verificationStatus' | 'paymentStatus';
  label: string;
  values: { value: string; count: number }[];
}

export const TRACKED_FIELDS: { field: keyof RiskInvoiceRecord; label: string; usedBy: string }[] = [
  { field: 'invoiceNumber', label: 'Invoice number', usedBy: 'Everything' },
  { field: 'invoiceAmount', label: 'Invoice amount', usedBy: 'Everything' },
  { field: 'invoiceDate', label: 'Invoice date', usedBy: 'Trends, aging' },
  { field: 'companyDebtorId', label: 'Debtor', usedBy: 'Concentration, credit check, debtor view' },
  { field: 'status', label: 'Status', usedBy: 'Pipeline, status mix' },
  { field: 'verificationStatus', label: 'Verification status', usedBy: 'Pipeline (Verified step)' },
  { field: 'invoiceBalance', label: 'Invoice balance', usedBy: 'Open A/R, aging, credit check' },
  { field: 'fundedDate', label: 'Funded date', usedBy: 'Pipeline, cash charts, statements' },
  { field: 'advanceAmount', label: 'Advance amount', usedBy: 'Cash charts, statements' },
  { field: 'escrowReserveAmount', label: 'Reserve amount', usedBy: 'Cash panel, statements' },
  { field: 'purchaseFeeAmount', label: 'Fee amount', usedBy: 'Fees, statements' },
  { field: 'paidDate', label: 'Paid date', usedBy: 'Days to collect, cash charts, statements' },
  { field: 'paymentStatus', label: 'Payment status', usedBy: 'Paid detection' },
  { field: 'dueDate', label: 'Due date', usedBy: 'Invoice detail' },
  { field: 'createdOn', label: 'Created on', usedBy: 'Submission calendar' },
];

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

export function fieldCoverage(records: RiskInvoiceRecord[]): FieldCoverage[] {
  return TRACKED_FIELDS.map(({ field, label, usedBy }) => {
    const count = records.filter((record) => present(record[field])).length;
    return { field, label, usedBy, present: count, total: records.length, share: records.length ? count / records.length : 0 };
  });
}

/**
 * Funded dates and amounts only exist once an invoice is funded, so their coverage is measured
 * against funded or paid invoices; paid date against paid invoices. Everything else against all.
 */
export function fairCoverage(records: RiskInvoiceRecord[]): FieldCoverage[] {
  const fundedish = records.filter((r) => /FUNDED|PURCHASED|PAID/.test((r.status ?? '').toUpperCase()));
  const paid = records.filter((r) => (r.status ?? '').toUpperCase() === 'PAID');
  const base = fieldCoverage(records);
  const scoped = (field: keyof RiskInvoiceRecord, subset: RiskInvoiceRecord[]) => {
    const row = base.find((r) => r.field === field)!;
    const count = subset.filter((record) => present(record[field])).length;
    return { ...row, present: count, total: subset.length, share: subset.length ? count / subset.length : 0 };
  };
  return base.map((row) => {
    if (['fundedDate', 'advanceAmount', 'escrowReserveAmount', 'purchaseFeeAmount'].includes(row.field)) return scoped(row.field, fundedish);
    if (row.field === 'paidDate') return scoped(row.field, paid);
    return row;
  });
}

export function valueCounts(records: RiskInvoiceRecord[]): ValueCounts[] {
  const fields: ValueCounts['field'][] = ['status', 'verificationStatus', 'paymentStatus'];
  const labels = { status: 'Status', verificationStatus: 'Verification status', paymentStatus: 'Payment status' };
  return fields.map((field) => {
    const counts = new Map<string, number>();
    for (const record of records) {
      const value = record[field] ?? '(empty)';
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return { field, label: labels[field], values: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count) };
  });
}
