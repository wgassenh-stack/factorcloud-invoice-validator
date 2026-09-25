import type { RiskInvoiceRecord } from './risk';

export interface ActivityPoint {
  key: string;
  label: string;
  amount: number;
  count: number;
}

export interface StatusMixItem {
  status: string;
  label: string;
  count: number;
  amount: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function buildWeeklyActivity(
  records: RiskInvoiceRecord[],
  weeks = 8,
  anchor: Date = new Date(),
): ActivityPoint[] {
  const bucketCount = Math.max(1, Math.floor(weeks));
  const currentWeekStart = startOfWeekUtc(anchor);
  const firstWeekStart = currentWeekStart - (bucketCount - 1) * WEEK_MS;
  const buckets: ActivityPoint[] = Array.from({ length: bucketCount }, (_, index) => {
    const start = firstWeekStart + index * WEEK_MS;
    return {
      key: new Date(start).toISOString().slice(0, 10),
      label: shortDate(start),
      amount: 0,
      count: 0,
    };
  });

  for (const record of records) {
    if (!record.invoiceDate) continue;
    const date = Date.parse(`${record.invoiceDate}T00:00:00Z`);
    if (!Number.isFinite(date)) continue;
    const weekStart = startOfWeekUtc(new Date(date));
    const index = Math.floor((weekStart - firstWeekStart) / WEEK_MS);
    if (index < 0 || index >= buckets.length) continue;
    buckets[index].count += 1;
    buckets[index].amount += record.invoiceAmount ?? 0;
  }

  return buckets;
}

export function buildStatusMix(records: RiskInvoiceRecord[]): StatusMixItem[] {
  const byStatus = new Map<string, StatusMixItem>();
  for (const record of records) {
    const status = record.status?.trim() || 'UNKNOWN';
    const current = byStatus.get(status) ?? {
      status,
      label: prettyStatus(status),
      count: 0,
      amount: 0,
    };
    current.count += 1;
    current.amount += record.invoiceAmount ?? 0;
    byStatus.set(status, current);
  }
  return [...byStatus.values()].sort((a, b) => b.count - a.count || b.amount - a.amount);
}

export function periodAmount(
  records: RiskInvoiceRecord[],
  days: number,
  anchor: Date = new Date(),
  offsetDays = 0,
): number {
  const { start, end } = dateWindow(days, anchor, offsetDays);
  return records.reduce((total, record) => {
    const date = record.invoiceDate ? Date.parse(`${record.invoiceDate}T00:00:00Z`) : NaN;
    if (!Number.isFinite(date) || date < start || date > end) return total;
    return total + (record.invoiceAmount ?? 0);
  }, 0);
}

export function periodCount(
  records: RiskInvoiceRecord[],
  days: number,
  anchor: Date = new Date(),
  offsetDays = 0,
): number {
  const { start, end } = dateWindow(days, anchor, offsetDays);
  return records.reduce((count, record) => {
    const date = record.invoiceDate ? Date.parse(`${record.invoiceDate}T00:00:00Z`) : NaN;
    return Number.isFinite(date) && date >= start && date <= end ? count + 1 : count;
  }, 0);
}

export function averageInvoiceAmount(records: RiskInvoiceRecord[]): number {
  const valued = records.filter((record) => record.invoiceAmount !== null && Number.isFinite(record.invoiceAmount));
  if (!valued.length) return 0;
  return valued.reduce((sum, record) => sum + (record.invoiceAmount ?? 0), 0) / valued.length;
}

export function trendPercent(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}

export function prettyStatus(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dateWindow(days: number, anchor: Date, offsetDays: number): { start: number; end: number } {
  const count = Math.max(1, Math.floor(days));
  const offset = Math.max(0, Math.floor(offsetDays));
  const anchorDay = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const end = anchorDay - offset * DAY_MS + (DAY_MS - 1);
  const start = anchorDay - (offset + count - 1) * DAY_MS;
  return { start, end };
}

function startOfWeekUtc(date: Date): number {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = new Date(day).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return day - daysSinceMonday * DAY_MS;
}

function shortDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(timestamp));
}
