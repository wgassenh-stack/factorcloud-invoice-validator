import 'server-only';

import { openBalance } from './analytics';
import type { DebtorCredit } from './credit';
import { getClientDebtor, listInvoices } from './factorcloud';
import { collectRiskInvoiceRecords } from './risk';
import type { CompanyRecord } from './types';

/**
 * Credit position for a client–debtor pair: FactorCloud's credit terms plus the unpaid balance the
 * debtor already owes on this client's invoices. Never throws: a lookup problem becomes
 * `lookupFailed`, which the check reports as skipped rather than blocking the submission.
 */
export async function loadDebtorCredit(clientId: string, debtor: CompanyRecord, invoiceAmount: number | null): Promise<DebtorCredit> {
  const noBuy = debtor.noBuy === true || (debtor as { buyStatus?: unknown }).buyStatus === false;
  const base = { debtorId: debtor.id, debtorName: debtor.companyName || debtor.compCode || 'this debtor', noBuy, thisInvoice: invoiceAmount && invoiceAmount > 0 ? invoiceAmount : 0 };
  try {
    const [terms, list] = await Promise.all([getClientDebtor(clientId, debtor.id), listInvoices({ client: clientId, debtor: debtor.id })]);
    const open = collectRiskInvoiceRecords(list.raw)
      .filter((record) => record.companyClientId === clientId && record.companyDebtorId === debtor.id)
      .map((record) => openBalance(record))
      .filter((balance) => balance > 0);
    return {
      ...base,
      limit: terms?.creditLimit ?? null,
      approved: terms?.creditLimitApproved ?? null,
      rating: terms?.creditRating ?? null,
      openBalance: open.reduce((sum, b) => sum + b, 0),
      openCount: open.length,
      lookupFailed: !list.complete ? true : undefined,
    };
  } catch (err) {
    console.error('[debtor-credit] lookup failed', err);
    return { ...base, limit: null, approved: null, rating: null, openBalance: 0, openCount: 0, lookupFailed: true };
  }
}
