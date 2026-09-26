'use client';

import { creditAfter, creditCheck, type DebtorCredit } from '@/lib/credit';
import { StatusFlag, VIZ, compactMoney, money } from './CommandCharts';

/** How much of the debtor's credit limit is in use, and where this invoice lands. */
export function CreditMeter({ credit }: { credit: DebtorCredit }) {
  const check = creditCheck(credit);
  if (!check) return null;
  const limit = credit.limit && credit.limit > 0 ? credit.limit : null;
  const after = creditAfter(credit);
  const scale = Math.max(limit ?? 0, after, 1);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const over = limit !== null && after > limit;

  return <div className={`creditMeter ${check.status.toLowerCase()}`}>
    <div className="creditMeterHead">
      <div><span>Credit with {credit.debtorName}</span><strong>{limit ? `${compactMoney(after)} of ${compactMoney(limit)}` : compactMoney(after)}</strong></div>
      {check.status === 'PASS' && <StatusFlag level="GOOD">Within limit</StatusFlag>}
      {check.status === 'REVIEW' && <StatusFlag level={over || credit.noBuy ? 'HIGH' : 'REVIEW'}>{credit.noBuy ? 'Not approved for purchase' : over ? 'Over limit' : 'Limit not approved'}</StatusFlag>}
    </div>
    {limit !== null && !credit.noBuy && <div className="creditBar" role="img" aria-label={check.message}>
      <span className="creditOpen" style={{ width: pct(credit.openBalance), background: VIZ.blue }} title={`Already open: ${money(credit.openBalance)}`} />
      <span className="creditThis" style={{ width: pct(Math.min(credit.thisInvoice, Math.max(0, scale - credit.openBalance))), background: over ? VIZ.critical : VIZ.orange }} title={`This invoice: ${money(credit.thisInvoice)}`} />
      <i className="creditLimitMark" style={{ left: pct(limit) }} />
    </div>}
    <div className="creditLegend">
      <span><i style={{ background: VIZ.blue }} />Already open {money(credit.openBalance)} ({credit.openCount} invoice{credit.openCount === 1 ? '' : 's'})</span>
      <span><i style={{ background: over ? VIZ.critical : VIZ.orange }} />This invoice {money(credit.thisInvoice)}</span>
      {limit !== null && <span>{over ? `${money(after - limit)} over` : `${money(limit - after)} left`}</span>}
    </div>
    {check.status !== 'PASS' && <small className="creditNote">{check.message}{check.status === 'REVIEW' ? ' You can still submit; your factor will review it.' : ''}</small>}
  </div>;
}
