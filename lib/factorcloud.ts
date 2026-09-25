import 'server-only';

import { cookies } from 'next/headers';
import type { CompanyRecord } from './types';
import { collectInvoiceRecords, findToken, unwrapRecord } from './fc-response';
import { normalizeIdentifier } from './normalize';
import { scoreDebtor, type DebtorHints } from './matching';

export const TOKEN_COOKIE = 'fc_token';
export const INTERIM_COOKIE = 'fc_interim';

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/', maxAge };
}

export class FactorCloudError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
  }
}

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
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [350, 900];

export async function fcRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { base, factorId } = config();
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { factorId, Accept: 'application/json' };
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
    const res = await fetch(url, { method, headers, body, cache: 'no-store' });
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
  const body = await fcRequest(`/companies/${encodeURIComponent(id)}`);
  const record = unwrapRecord(body, ['company']);
  if (!record) throw new FactorCloudError(`Company ${id} response had no record.`, 502, body);
  return record as unknown as CompanyRecord;
}

function idList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function findDebtor(hints: DebtorHints): Promise<{ debtor: CompanyRecord; method: string; score: number } | null> {
  const ids = idList(process.env.FACTORCLOUD_DEBTOR_IDS);
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

export async function findExistingInvoice(clientId: string, _debtorId: string, invoiceNumber: string): Promise<{ id: string; status?: string | null } | null> {
  const body = await fcRequest('/invoices');
  const target = normalizeIdentifier(invoiceNumber);
  const match = collectInvoiceRecords(body).find((x) =>
    normalizeIdentifier(x.invoiceNumber) === target &&
    x.companyClientId === clientId,
  );
  return match ? { id: match.id, status: match.status } : null;
}

export async function createInvoice(invoice: NewInvoice): Promise<{ id: string; raw: unknown }> {
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

export async function attachDocuments(invoiceId: string, documentIds: string[]): Promise<unknown> {
  return fcRequest(`/invoices/${encodeURIComponent(invoiceId)}`, { method: 'PUT', json: { documents: documentIds } });
}
