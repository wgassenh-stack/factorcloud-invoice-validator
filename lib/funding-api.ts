import 'server-only';

import { FactorCloudError, fcRequest } from './factorcloud';

// The FactorCloud calls the funding engine uses, all from the published API reference:
//   GET   /clients/{id}                              client credit limit
//   GET   /ledgers/cash-reserve?client=              cash reserve entries
//   GET   /companies/{client}/funding-instruction    where the client is paid
//   PATCH /invoices/verification                      mark invoices verified
//   PATCH /invoices/approve-for-funding               approve: creates a funding batch (invoice group)
//   PATCH /invoice-groups/fund                        fund the batch: this moves money

const num = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN);

/** The client's own credit limit: null when none is set. */
export async function getClientCreditLimit(clientId: string): Promise<number | null> {
  const body = await fcRequest<Record<string, unknown>>(`/clients/${encodeURIComponent(clientId)}`);
  const client = (body.client ?? body.data ?? body) as Record<string, unknown>;
  const limit = num(client.creditLimit);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/** The client's cash reserve balance: what the ledger's increases and decreases add up to. */
export async function getCashReserveBalance(clientId: string): Promise<number> {
  let balance = 0;
  const limit = 200;
  for (let page = 0; page < 25; page++) {
    const body = await fcRequest<{ ledgers?: { increaseAmount?: unknown; decreaseAmount?: unknown }[] }>('/ledgers/cash-reserve', {
      query: { client: clientId },
      headers: { 'X-PAGINATION-NUM': String(page), 'X-PAGINATION-LIMIT': String(limit) },
    });
    const rows = Array.isArray(body.ledgers) ? body.ledgers : [];
    for (const row of rows) balance += (num(row.increaseAmount) || 0) - (num(row.decreaseAmount) || 0);
    if (rows.length < limit) return Math.round(balance * 100) / 100;
  }
  throw new FactorCloudError('The cash reserve ledger is too long to add up.', 502, null);
}

export interface FundingInstruction { id: string; name: string; paymentMethod: string; isDefault: boolean }

export async function listFundingInstructions(clientId: string): Promise<FundingInstruction[]> {
  const body = await fcRequest<{ paymentInformationList?: Record<string, unknown>[] }>(`/companies/${encodeURIComponent(clientId)}/funding-instruction`);
  return (body.paymentInformationList ?? [])
    .filter((row) => typeof row.id === 'string')
    .map((row) => ({ id: String(row.id), name: String(row.name ?? ''), paymentMethod: String(row.paymentMethod ?? ''), isDefault: row.default === true }));
}

/** The client's default funding instruction, else its first. */
export function pickFundingInstruction(list: FundingInstruction[]): FundingInstruction | null {
  return list.find((i) => i.isDefault) ?? list[0] ?? null;
}

/** Payment types the fund call accepts. */
export const FUNDABLE_PAYMENT_TYPES = ['ACH', 'CHECK', 'WIRE', 'FUEL_CARD', 'EXPRESS_CODE', 'SAME_DAY_ACH'] as const;

export async function verifyInvoices(invoiceIds: string[], notes: string): Promise<void> {
  await fcRequest('/invoices/verification', { method: 'PATCH', json: { invoiceIds, verificationStatus: 'VERIFIED', verificationMethod: 'ONLINE PORTAL', verificationNotes: notes } });
}

export interface InvoiceGroup { id: string; code: string | null; status: string | null; paymentAmount: number | null; reserveAmount: number | null; paymentType: string | null }

/** Approves invoices for funding. FactorCloud puts them in a funding batch (invoice group) and returns it. */
export async function approveForFunding(clientId: string, fundingInstructionId: string, invoiceIds: string[]): Promise<InvoiceGroup[]> {
  const body = await fcRequest<{ invoiceGroups?: Record<string, unknown>[] }>('/invoices/approve-for-funding', {
    method: 'PATCH',
    json: { companyClientId: clientId, fundingInstructionId, invoiceIds },
  });
  return (body.invoiceGroups ?? []).filter((g) => typeof g.id === 'string').map((g) => ({
    id: String(g.id),
    code: typeof g.code === 'string' ? g.code : null,
    status: typeof g.status === 'string' ? g.status : null,
    paymentAmount: Number.isFinite(num(g.paymentAmount)) ? num(g.paymentAmount) : null,
    reserveAmount: Number.isFinite(num(g.reserveAmount)) ? num(g.reserveAmount) : null,
    paymentType: typeof g.paymentType === 'string' ? g.paymentType : null,
  }));
}

/** Funds batches. This moves money. `transactionId` must be unique per funding. */
export async function fundInvoiceGroups(invoiceGroupIds: string[], paymentType: string, transactionId: string): Promise<void> {
  await fcRequest('/invoice-groups/fund', { method: 'PATCH', json: { action: 'fund', invoiceGroups: invoiceGroupIds, paymentType, transactionId } });
}
