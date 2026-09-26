// Debtor view for factor staff: who owes the most across all clients, how old it is, and how fast
// each debtor pays. Pure, over FactorCloud invoice records.

import { isClosedOut, isPaid, lifecycleStage, openBalance } from './analytics';
import type { RiskInvoiceRecord } from './risk';

const DAY_MS = 86_400_000;

export interface DebtorSummary {
  debtorId: string;
  name: string;
  openBalance: number;
  openCount: number;
  /** Share of all open balance across debtors. */
  share: number;
  clientCount: number;
  topClient: string | null;
  /** Open balance by age of invoice: 0–30, 31–60, 61–90, 90+ days. */
  buckets: [number, number, number, number];
  /** Amount-weighted days from invoice to payment, invoices paid in the last 180 days. */
  daysToPay: number | null;
  paidCount: number;
  disputedCount: number;
  oldestOpenDays: number | null;
  /** Invoice amount dated in the last 90 days. */
  recentVolume: number;
}

export function buildDebtorSummaries(records: RiskInvoiceRecord[], today: string, names: { debtors: Record<string, string>; clients: Record<string, string> }): DebtorSummary[] {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const day = (value: string | null | undefined) => (value ? Date.parse(`${value.slice(0, 10)}T00:00:00Z`) : NaN);
  type Acc = DebtorSummary & { clientTotals: Map<string, number>; weighted: number; weight: number };
  const byDebtor = new Map<string, Acc>();

  for (const record of records) {
    if (!record.companyDebtorId || isClosedOut(record)) continue;
    const id = record.companyDebtorId;
    const acc = byDebtor.get(id) ?? {
      debtorId: id, name: names.debtors[id] || record.companyDebtorName || id, openBalance: 0, openCount: 0, share: 0, clientCount: 0, topClient: null,
      buckets: [0, 0, 0, 0], daysToPay: null, paidCount: 0, disputedCount: 0, oldestOpenDays: null, recentVolume: 0,
      clientTotals: new Map<string, number>(), weighted: 0, weight: 0,
    } as Acc;
    const issued = day(record.invoiceDate);
    if (Number.isFinite(issued) && todayMs - issued <= 89 * DAY_MS) acc.recentVolume += record.invoiceAmount ?? 0;

    const funded = lifecycleStage(record) === 'FUNDED';
    const balance = funded ? openBalance(record) : 0;
    if (balance > 0) {
      acc.openBalance += balance;
      acc.openCount += 1;
      const age = Number.isFinite(issued) ? Math.floor((todayMs - issued) / DAY_MS) : null;
      if (age != null) {
        acc.buckets[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3] += balance;
        acc.oldestOpenDays = Math.max(acc.oldestOpenDays ?? 0, age);
      }
      if (record.companyClientId) acc.clientTotals.set(record.companyClientId, (acc.clientTotals.get(record.companyClientId) ?? 0) + balance);
      if (record.disputed) acc.disputedCount += 1;
    }
    const paid = day(record.paidDate);
    if (isPaid(record) && Number.isFinite(paid) && Number.isFinite(issued) && todayMs - paid <= 179 * DAY_MS) {
      const w = Math.max(record.invoiceAmount ?? 0, 1);
      acc.weighted += ((paid - issued) / DAY_MS) * w;
      acc.weight += w;
      acc.paidCount += 1;
    }
    byDebtor.set(id, acc);
  }

  const total = [...byDebtor.values()].reduce((sum, d) => sum + d.openBalance, 0);
  return [...byDebtor.values()]
    .map(({ clientTotals, weighted, weight, ...d }) => {
      const top = [...clientTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      return { ...d, share: total > 0 ? d.openBalance / total : 0, clientCount: clientTotals.size, topClient: top ? names.clients[top] || top : null, daysToPay: weight > 0 ? weighted / weight : null };
    })
    .sort((a, b) => b.openBalance - a.openBalance || b.recentVolume - a.recentVolume);
}
