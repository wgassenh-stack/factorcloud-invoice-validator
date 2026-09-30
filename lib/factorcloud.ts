import 'server-only';

import { cookies } from 'next/headers';
import type { CompanyRecord } from './types';
import { FactorCloudError } from './errors';
import { collectInvoiceRecords, findToken, unwrapRecord } from './fc-response';
import { labelsIn, type InvoiceLabel } from './labels';
import { normalizeIdentifier } from './normalize';
import { scoreDebtor, type DebtorHints } from './matching';
import { addDemoInvoice, demoClientDebtor, demoCompany, demoDebtors, demoInvoice, demoInvoices, nextDemoDocumentId } from './demo-store';
import { demoRequest } from './demo-request';

export const TOKEN_COOKIE = 'fc_token';
export const INTERIM_COOKIE = 'fc_interim';

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge };
}

export { FactorCloudError } from './errors';

function config() {
  const base = (process.env.FACTORCLOUD_API_BASE || 'https://api.int.factorcloud.com').replace(/\/+$/, '');
  const factorId = process.env.FACTORCLOUD_FACTOR_ID;
  if (!factorId) throw new FactorCloudError('FACTORCLOUD_FACTOR_ID is not configured.', 500, null);
  return { base, factorId };
}

export async function currentToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(TOKEN_COOKIE)?.value || process.env.FACTORCLOUD_BEARER_TOKEN || null;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  token?: string | null;
  auth?: boolean;
  headers?: Record<string, string>;
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [350, 900];

export async function fcRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  // Demo mode must never reach a real FactorCloud; every caller has a demo branch above this.
  if (await demoRequest()) throw new FactorCloudError('FactorCloud is not connected in demo mode.', 503, null);
  const { base, factorId } = config();
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { ...opts.headers, factorId, Accept: 'application/json' };
  if (opts.auth !== false) {
    const token = opts.token !== undefined ? opts.token : await currentToken();
    if (!token) throw new FactorCloudError('Not signed in to FactorCloud.', 401, null);
    headers.Authorization = `Bearer ${token}`;
  }
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  const attempts = method === 'GET' ? 1 + RETRY_DELAYS_MS.length : 1;
  let lastError: FactorCloudError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, cache: 'no-store', signal: AbortSignal.timeout(30000) });
    } catch (err) {
      // No HTTP response (DNS, connection reset, timeout). For a write the outcome is unknown.
      console.error(`[factorcloud] ${method} ${path} network error`, err);
      throw new FactorCloudError(`FactorCloud could not be reached (${method} ${path}).`, 503, null);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (res.ok) return parsed as T;

    lastError = new FactorCloudError(`FactorCloud ${method} ${path} failed (${res.status}): ${describe(parsed)}`, res.status, parsed);
    const shouldRetry = method === 'GET' && TRANSIENT_STATUSES.has(res.status) && attempt < attempts - 1;
    if (!shouldRetry) throw lastError;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw lastError ?? new FactorCloudError(`FactorCloud ${method} ${path} failed.`, 502, null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b.message ?? b.error ?? b.errors ?? b.status;
    if (msg) return typeof msg === 'string' ? msg : JSON.stringify(msg);
  }
  return typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300) ?? '';
}

export async function startLogin(): Promise<string> {
  const username = process.env.FACTORCLOUD_USERNAME;
  const password = process.env.FACTORCLOUD_PASSWORD;
  if (!username || !password) throw new FactorCloudError('FACTORCLOUD_USERNAME / FACTORCLOUD_PASSWORD are not configured.', 500, null);
  const body = await fcRequest('/authentications/generate-token', { method: 'POST', json: { username, password }, auth: false });
  const interim = findToken(body);
  if (!interim) throw new FactorCloudError('generate-token response did not include a token.', 502, body);
  return interim;
}

export async function completeLogin(interimToken: string, otpCode: string): Promise<string> {
  const body = await fcRequest('/authentications/login', {
    method: 'POST',
    json: { username: process.env.FACTORCLOUD_USERNAME, password: process.env.FACTORCLOUD_PASSWORD, otpCode },
    token: interimToken,
  });
  const token = findToken(body);
  if (!token) throw new FactorCloudError('login response did not include a token.', 502, body);
  return token;
}

export async function getCompany(id: string): Promise<CompanyRecord> {
  if (await demoRequest()) {
    const company = demoCompany(id);
    if (!company) throw new FactorCloudError(`Company ${id} not found.`, 404, null);
    return company;
  }
  const body = await fcRequest(`/companies/${encodeURIComponent(id)}`);
  const record = unwrapRecord(body, ['company']);
  if (!record) throw new FactorCloudError(`Company ${id} response had no record.`, 502, body);
  return record as unknown as CompanyRecord;
}

function idList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The debtors this portal may submit invoices against. */
export async function allowedDebtorIds(): Promise<string[]> {
  if (await demoRequest()) return demoDebtors().map((debtor) => debtor.id);
  return idList(process.env.FACTORCLOUD_DEBTOR_IDS);
}

export async function findDebtor(hints: DebtorHints): Promise<{ debtor: CompanyRecord; method: string; score: number } | null> {
  const ids = await allowedDebtorIds();
  const settled = await Promise.allSettled(ids.map((id) => getCompany(id)));
  const candidates = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (!candidates.length && ids.length) {
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  let best: { debtor: CompanyRecord; method: string; score: number } | null = null;
  for (const debtor of candidates) {
    const scored = scoreDebtor(hints, debtor);
    if (scored && (!best || scored.score > best.score)) best = { debtor, ...scored };
  }
  return best;
}

export interface NewInvoice {
  invoiceNumber: string;
  referenceNumber: string | null;
  companyClientId: string;
  companyDebtorId: string;
  invoiceAmount: number;
  invoiceDate: string;
  notes: string | null;
}

export interface InvoiceListQuery {
  /** FactorCloud company client ID: only that client's invoices. */
  client?: string;
  /** FactorCloud search: matches invoice number, reference number, client/debtor name or amount. */
  q?: string;
  /** FactorCloud company debtor ID: only invoices owed by that debtor. */
  debtor?: string;
}

export interface InvoiceListResult {
  /** Raw FactorCloud response bodies, one per page. The record collectors walk arrays, so pass as-is. */
  raw: unknown[];
  /** True only when the last page was reached, so every matching invoice is included. */
  complete: boolean;
  /** Why the list may be incomplete, when it is. */
  incompleteReason?: string;
  pages: number;
}

// FactorCloud paginates GET /invoices with request headers (0-based page number and page size,
// default size 20) and returns no total count, so the end is found by reading until a page comes
// back short or empty. Ordering is stable (sorted by id by default).
export const INVOICE_PAGE_SIZE = Math.min(Math.max(Number(process.env.FACTORCLOUD_PAGE_SIZE) || 100, 1), 500);
const FACTORCLOUD_DEFAULT_PAGE_SIZE = 20;
export const MAX_INVOICE_PAGES = 200;

/**
 * The one place that reads FactorCloud's invoice list, fetching every page. Callers use `complete`
 * to decide whether the result can be trusted as the whole set.
 */
export async function listInvoices(filter: InvoiceListQuery = {}): Promise<InvoiceListResult> {
  if (await demoRequest()) {
    const q = filter.q?.toLowerCase();
    const invoices = demoInvoices().filter((invoice) =>
      (!filter.client || invoice.companyClientId === filter.client)
      && (!filter.debtor || invoice.companyDebtorId === filter.debtor)
      && (!q || invoice.invoiceNumber.toLowerCase().includes(q) || invoice.referenceNumber.toLowerCase().includes(q)),
    );
    return { raw: [{ status: 'SUCCESS', code: 200, invoices }], complete: true, pages: 1 };
  }
  const query: Record<string, string> = {};
  if (filter.client) query.client = filter.client;
  if (filter.q) query.q = filter.q;
  if (filter.debtor) query.debtor = filter.debtor;

  const raw: unknown[] = [];
  const seen = new Set<string>();
  let limit = INVOICE_PAGE_SIZE;
  // A short page only proves the end once FactorCloud has shown it honors our page size (it could
  // cap it silently). Until then, keep reading until an empty page.
  let limitHonored = false;

  for (let page = 0; page < MAX_INVOICE_PAGES; page++) {
    let body: unknown;
    try {
      body = await fcRequest('/invoices', {
        query,
        headers: { 'X-PAGINATION-NUM': String(page), 'X-PAGINATION-LIMIT': String(limit) },
      });
    } catch (err) {
      // A page size above FactorCloud's maximum may be refused; fall back to its documented default.
      if (page === 0 && limit !== FACTORCLOUD_DEFAULT_PAGE_SIZE && err instanceof FactorCloudError && err.status === 400) {
        limit = FACTORCLOUD_DEFAULT_PAGE_SIZE;
        page = -1;
        continue;
      }
      throw err;
    }

    const items = invoicePageItems(body);
    if (!items.length) return { raw, complete: true, pages: page + 1 };
    const fresh = items.filter((item) => !seen.has(item.id));
    if (!fresh.length) {
      return { raw, complete: false, pages: page + 1, incompleteReason: 'FactorCloud returned the same invoices again, so its pagination was not applied.' };
    }
    for (const item of fresh) seen.add(item.id);
    raw.push(body);

    if (items.length === limit) limitHonored = true;
    if (items.length < limit && limitHonored) return { raw, complete: true, pages: page + 1 };
  }
  return { raw, complete: false, pages: MAX_INVOICE_PAGES, incompleteReason: `Stopped after ${MAX_INVOICE_PAGES} pages.` };
}

/** The invoices array of one list page (`{ invoices: [...] }`), falling back to any invoice-shaped records. */
function invoicePageItems(body: unknown): { id: string }[] {
  const invoices = (body as { invoices?: unknown } | null)?.invoices;
  if (Array.isArray(invoices)) {
    return invoices.filter((x): x is { id: string } => Boolean(x) && typeof (x as { id?: unknown }).id === 'string');
  }
  return collectInvoiceRecords(body);
}

export interface ClientDebtorTerms {
  creditLimit: number | null;
  creditLimitApproved: boolean | null;
  creditRating: number | null;
}

/** GET /clients/{clientId}/debtors/{debtorId}: credit terms for this client–debtor pair, or null if none. */
export async function getClientDebtor(clientId: string, debtorId: string): Promise<ClientDebtorTerms | null> {
  if (await demoRequest()) return demoClientDebtor(clientId, debtorId);
  let body: unknown;
  try {
    body = await fcRequest(`/clients/${encodeURIComponent(clientId)}/debtors/${encodeURIComponent(debtorId)}`);
  } catch (err) {
    if (err instanceof FactorCloudError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
  const raw = (body as { clientDebtors?: unknown; clientDebtor?: unknown } | null);
  const record = (Array.isArray(raw?.clientDebtors) ? raw.clientDebtors[0] : raw?.clientDebtors ?? raw?.clientDebtor) as Record<string, unknown> | undefined;
  if (!record) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    creditLimit: num(record.creditLimit),
    creditLimitApproved: typeof record.creditLimitApproved === 'boolean' ? record.creditLimitApproved : null,
    creditRating: num(record.creditRating),
  };
}

/** GET /invoices/{id}. Returns the raw response body, or null when FactorCloud has no such invoice. */
export async function getInvoice(invoiceId: string): Promise<unknown | null> {
  if (await demoRequest()) {
    const invoice = demoInvoice(invoiceId);
    return invoice ? { status: 'SUCCESS', code: 200, invoice } : null;
  }
  try {
    return await fcRequest(`/invoices/${encodeURIComponent(invoiceId)}`);
  } catch (err) {
    if (err instanceof FactorCloudError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

/**
 * A short-lived link to all of an invoice's documents combined into one PDF
 * (GET /invoices/{id}/combined-documentation). Null when FactorCloud has none to give.
 */
export async function invoiceDocumentsUrl(invoiceId: string): Promise<string | null> {
  const body = await fcRequest<{ downloadUrl?: unknown }>(`/invoices/${encodeURIComponent(invoiceId)}/combined-documentation`);
  return typeof body.downloadUrl === 'string' && /^https:\/\//.test(body.downloadUrl) ? body.downloadUrl : null;
}

/** Search terms that together find an invoice number despite punctuation differences ("INV-001" vs "INV001"). */
export function duplicateSearchTerms(invoiceNumber: string): string[] {
  const raw = invoiceNumber.trim();
  const normalized = normalizeIdentifier(raw);
  const digitRuns = raw.match(/\d{3,}/g) ?? [];
  const longestDigits = digitRuns.sort((a, b) => b.length - a.length)[0];
  return [...new Set([raw, normalized, longestDigits].filter((t): t is string => Boolean(t)))];
}

/**
 * Looks for an invoice with the same number (ignoring case and punctuation) for this client, across
 * every page. `complete` is false when any search could not be read to the end.
 */
export async function findExistingInvoice(clientId: string, invoiceNumber: string): Promise<{ existing: { id: string; status?: string | null } | null; complete: boolean }> {
  const target = normalizeIdentifier(invoiceNumber);
  let complete = true;
  for (const q of duplicateSearchTerms(invoiceNumber)) {
    const result = await listInvoices({ client: clientId, q });
    complete &&= result.complete;
    const match = collectInvoiceRecords(result.raw).find((x) =>
      normalizeIdentifier(x.invoiceNumber) === target && x.companyClientId === clientId,
    );
    if (match) return { existing: { id: match.id, status: match.status }, complete: true };
  }
  return { existing: null, complete };
}

export async function createInvoice(invoice: NewInvoice): Promise<{ id: string; raw: unknown }> {
  if (await demoRequest()) {
    const created = addDemoInvoice(invoice);
    return { id: created.id, raw: { invoice: created } };
  }
  const body = await fcRequest('/invoices', {
    method: 'POST',
    json: { ...invoice, invoiceDate: `${invoice.invoiceDate}T00:00:00Z`, dueDate: null },
  });
  const record = unwrapRecord(body, ['invoice']);
  if (!record || typeof record.id !== 'string') throw new FactorCloudError('Invoice created but the response had no invoice id.', 502, body);
  return { id: record.id, raw: body };
}

export const FC_DOCUMENT_TYPES: Record<string, string> = {
  invoice: 'INVOICE', bol: 'BOL', pod: 'POD', rate_confirmation: 'RATE_CONFIRMATION', other: 'OTHER',
};

export async function uploadDocument(clientId: string, file: File, type: string): Promise<{ id: string; type: string }> {
  if (await demoRequest()) return { id: nextDemoDocumentId(), type };
  const attempt = async (t: string) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const body = await fcRequest('/documents', { method: 'POST', query: { companyId: clientId, type: t, fileName: file.name }, form });
    const record = unwrapRecord(body, ['document']);
    if (!record || typeof record.id !== 'string') throw new FactorCloudError('Document uploaded but the response had no document id.', 502, body);
    return { id: record.id, type: t };
  };
  try { return await attempt(type); }
  catch (err) {
    if (type !== 'INVOICE' && err instanceof FactorCloudError && err.status === 400) return attempt('INVOICE');
    throw err;
  }
}

/** POST /invoices/{id}/documents: adds documents to an invoice without replacing the ones it has. */
export async function addDocumentsToInvoice(invoiceId: string, documentIds: string[]): Promise<unknown> {
  if (await demoRequest()) return { status: 'SUCCESS', invoiceId, documents: documentIds };
  return fcRequest(`/invoices/${encodeURIComponent(invoiceId)}/documents`, { method: 'POST', json: { documentIds } });
}

export type { InvoiceLabel } from './labels';

/** FactorCloud's invoice labels (set up by the factor in FactorCloud). Used by FactorCloud's own web app. */
export async function listInvoiceLabels(): Promise<InvoiceLabel[]> {
  if (await demoRequest()) return [];
  const body = await fcRequest('/labels', { query: { entityType: 'INVOICE' } });
  return labelsIn(body);
}

/**
 * Sets an invoice's labels, as FactorCloud's web app does (PATCH /invoices/{id}/labels). Not in the
 * published API reference, so callers treat a failure as non-fatal.
 */
export async function setInvoiceLabels(invoiceId: string, labelIds: string[]): Promise<unknown> {
  if (await demoRequest()) return { status: 'SUCCESS', invoiceId, labelIds };
  return fcRequest(`/invoices/${encodeURIComponent(invoiceId)}/labels`, { method: 'PATCH', json: { labelIds } });
}

/** The labels on one invoice (GET /invoices/{id}/labels, as FactorCloud's web app reads them). */
export async function getInvoiceLabels(invoiceId: string): Promise<InvoiceLabel[]> {
  if (await demoRequest()) return [];
  return labelsIn(await fcRequest(`/invoices/${encodeURIComponent(invoiceId)}/labels`));
}

/** Replaces an invoice's notes (PUT /invoices/{id}, documented). */
export async function updateInvoiceNotes(invoiceId: string, notes: string): Promise<unknown> {
  if (await demoRequest()) return { status: 'SUCCESS', invoiceId, notes };
  return fcRequest(`/invoices/${encodeURIComponent(invoiceId)}`, { method: 'PUT', json: { notes } });
}

export async function attachDocuments(invoiceId: string, documentIds: string[]): Promise<unknown> {
  if (await demoRequest()) return { status: 'SUCCESS', invoiceId, documents: documentIds };
  return fcRequest(`/invoices/${encodeURIComponent(invoiceId)}`, { method: 'PUT', json: { documents: documentIds } });
}
