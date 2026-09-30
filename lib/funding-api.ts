import 'server-only';

import { FactorCloudError, fcRequest } from './factorcloud';

// The FactorCloud calls the funding engine uses, all from the published API reference:
//   GET   /clients/{id}                              client credit limit
//   GET   /ledgers/cash-reserve?client=              cash reserve entries
//   GET   /companies/{client}/funding-instruction    where the client is paid
//   PATCH /invoices/verification                      mark invoices verified
//   PATCH /invoices/approve-for-funding               approve: creates a funding batch (invoice group)
//   PATCH /invoice-groups/fund                        fund the batch: this moves money
//   GET   /invoices/{id}/invoice-funding             which batch an invoice is in
//   GET   /invoice-groups/{id}                       a batch's status
//   GET   /invoice-groups/{id}/invoice-funding       every invoice in a batch
// FactorCloud funds whole batches, and approving an invoice adds it to the client's open batch.
// So before money moves, the engine checks what is really in the batch.

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
    if (!Array.isArray(body.ledgers)) throw new FactorCloudError('Cash reserve response was not recognized.',502,null);
    const rows = body.ledgers;
    if (rows.some(row => !Number.isFinite(num(row.increaseAmount)) || !Number.isFinite(num(row.decreaseAmount)))) throw new FactorCloudError('Cash reserve amounts are missing or invalid.',502,null);
    for (const row of rows) balance += (num(row.increaseAmount) || 0) - (num(row.decreaseAmount) || 0);
    if (rows.length < limit) return Math.round(balance * 100) / 100;
  }
  throw new FactorCloudError('The cash reserve ledger is too long to add up.', 502, null);
}

export interface FundingInstruction { id: string; name: string; paymentMethod: string; isDefault: boolean }

export async function listFundingInstructions(clientId: string): Promise<FundingInstruction[]> {
  return fundingInstructionsIn(await fundingInstructionsRaw(clientId));
}

export async function fundingInstructionsRaw(clientId: string): Promise<unknown> {
  return fcRequest(`/companies/${encodeURIComponent(clientId)}/funding-instruction`);
}

/**
 * Every funding instruction in a response, however it's wrapped: the docs show
 * `{ paymentInformationList: [...] }`, but the live API may name the list differently or return one
 * object. An instruction is anything with an id and a payment method.
 */
export function fundingInstructionsIn(body: unknown): FundingInstruction[] {
  const found: FundingInstruction[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    const row = value as Record<string, unknown>;
    const method = row.paymentMethod ?? row.paymentType ?? row.method;
    if (typeof row.id === 'string' && typeof method === 'string') {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        found.push({
          id: row.id,
          name: String(row.name ?? row.nickname ?? row.nickName ?? ''),
          paymentMethod: method.toUpperCase().replace(/\s+/g, '_'),
          isDefault: row.default === true || row.isDefault === true || row.defaultInstruction === true,
        });
      }
      return;
    }
    Object.values(row).forEach((item) => visit(item, depth + 1));
  };
  visit(body, 0);
  return found;
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


const PAGE = 200;
const pageHeaders = (page: number) => ({ 'X-PAGINATION-NUM': String(page), 'X-PAGINATION-LIMIT': String(PAGE), pageNumber: String(page), pageLimit: String(PAGE) });
type InvoiceFunding = { invoiceId?: unknown; invoiceGroupId?: unknown; createdOn?: unknown };
const fundingsIn = (body: unknown): InvoiceFunding[] => {
  const list = (body as { invoiceFundings?: unknown })?.invoiceFundings;
  if (!Array.isArray(list)) throw new FactorCloudError('The funding batch response was not recognized.', 502, null);
  return list as InvoiceFunding[];
};

/** The batch FactorCloud put an invoice in: the most recent one, or null if it is in none. */
export async function invoiceGroupOf(invoiceId: string): Promise<string | null> {
  const rows = fundingsIn(await fcRequest(`/invoices/${encodeURIComponent(invoiceId)}/invoice-funding`, { headers: pageHeaders(0) }));
  const latest = rows.filter((r) => typeof r.invoiceGroupId === 'string')
    .sort((a, b) => String(b.createdOn ?? '').localeCompare(String(a.createdOn ?? '')))[0];
  return latest ? String(latest.invoiceGroupId) : null;
}

/** Every invoice in a batch. Funding the batch funds all of them. */
export async function groupInvoiceIds(groupId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 0; page < 25; page++) {
    const rows = fundingsIn(await fcRequest(`/invoice-groups/${encodeURIComponent(groupId)}/invoice-funding`, { headers: pageHeaders(page) }));
    const before = ids.size;
    for (const row of rows) if (typeof row.invoiceId === 'string') ids.add(row.invoiceId);
    // Stop at a short page, or if the API ignores paging and repeats the same rows.
    if (rows.length < PAGE || ids.size === before) return [...ids];
  }
  throw new FactorCloudError('The funding batch is too large to check.', 502, null);
}

/** A batch's code and status (NOT_FUNDED until it is funded). */
export async function getInvoiceGroup(groupId: string): Promise<InvoiceGroup> {
  const body = await fcRequest<{ invoiceGroup?: Record<string, unknown> }>(`/invoice-groups/${encodeURIComponent(groupId)}`);
  const g = body.invoiceGroup;
  if (!g || typeof g.id !== 'string') throw new FactorCloudError('The funding batch response was not recognized.', 502, null);
  return {
    id: g.id, code: typeof g.code === 'string' ? g.code : null, status: typeof g.status === 'string' ? g.status : null,
    paymentAmount: Number.isFinite(num(g.paymentAmount)) ? num(g.paymentAmount) : null,
    reserveAmount: Number.isFinite(num(g.reserveAmount)) ? num(g.reserveAmount) : null,
    paymentType: typeof g.paymentType === 'string' ? g.paymentType : null,
  };
}
