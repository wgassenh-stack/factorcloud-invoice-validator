import { isClosedOut, isPaid, lifecycleStage, openArBalance, openBalance, reserveOn } from './analytics';
import type { RiskInvoiceRecord } from './risk';

/**
 * Where the client stands now. Funded money still out (with reserves and aging) counts funded
 * invoices only. Approved invoices aren't funded yet, so they sit with the rest of what was sent in,
 * but they do use credit, as in FactorCloud: credit exposure is funded plus approved.
 */
export function clientPosition(records: RiskInvoiceRecord[], today: string) {
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const aging = [0, 0, 0, 0];
  let openAr = 0, openArCount = 0, reserveHeld = 0, pendingAmount = 0, pendingCount = 0, approvedAmount = 0, approvedCount = 0;
  for (const r of records) {
    if (isClosedOut(r) || isPaid(r)) continue;
    if (lifecycleStage(r) === 'FUNDED') {
      const balance = openArBalance(r) || openBalance(r);
      if (balance <= 0) continue;
      openAr += balance; openArCount += 1; reserveHeld += reserveOn(r);
      const age = r.invoiceDate ? Math.floor((todayMs - Date.parse(`${r.invoiceDate.slice(0, 10)}T00:00:00Z`)) / 86_400_000) : 0;
      aging[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3] += balance;
      continue;
    }
    const amount = r.invoiceAmount ?? 0;
    pendingAmount += amount; pendingCount += 1;
    if ((r.status ?? '').trim().toUpperCase() === 'APPROVED') { approvedAmount += amount; approvedCount += 1; }
  }
  return { openAr, openArCount, reserveHeld, pendingAmount, pendingCount, approvedAmount, approvedCount, creditExposure: openAr + approvedAmount, aging };
}
