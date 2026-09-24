import 'server-only';

import { cookies } from 'next/headers';
import type { CompanyRecord } from './types';
import { findToken, unwrapRecord } from './fc-response';
import { scoreDebtor, type DebtorHints } from './matching';

// Server-only FactorCloud API client. Credentials never reach the browser.
//
// Auth (prototype): the bearer token comes from the `fc_token` cookie set by the
// OTP sign-in flow (/api/auth/*), falling back to FACTORCLOUD_BEARER_TOKEN.
// Production needs a machine-to-machine credential from FactorCloud; see README.

export const TOKEN_COOKIE = 'fc_token';
export const INTERIM_COOKIE = 'fc_interim';

export function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge,
  };
}

export class FactorCloudError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
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
  /** Override the bearer token (used during login with the interim token). */
  token?: string | null;
  auth?: boolean;
}

export async function fcRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { base, factorId } = config();
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const headers: Record<string, string> = { factorId, Accept: 'application/json' };
  if (opts.auth !== false) {
    const token = opts.token !== undefined ? opts.token : await currentToken();
    if (!token) throw new FactorCloudError('Not signed in to FactorCloud.', 401, null);
    headers.Authorization = `Bearer ${token}`;
  }

  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form; // fetch sets the multipart boundary; never set Content-Type by hand
  } else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  const res = await fetch(url, { method: opts.method ?? 'GET', headers, body, cache: 'no-store' });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // leave as text
  }
  if (!res.ok) {
    throw new FactorCloudError(`FactorCloud ${opts.method ?? 'GET'} ${path} failed (${res.status}): ${describe(parsed)}`, res.status, parsed);
  }
  return parsed as T;
}

function describe(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b.message ?? b.error ?? b.errors ?? b.status;
    if (msg) return typeof msg === 'string' ? msg : JSON.stringify(msg);
  }
  return typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300) ?? '';
}

// ---------------------------------------------------------------------------
// Auth (email OTP flow proven in Postman)

export async function startLogin(): Promise<string> {
  const username = process.env.FACTORCLOUD_USERNAME;
  const password = process.env.FACTORCLOUD_PASSWORD;
  if (!username || !password) throw new FactorCloudError('FACTORCLOUD_USERNAME / FACTORCLOUD_PASSWORD are not configured.', 500, null);
  const body = await fcRequest('/authentications/generate-token', {
    method: 'POST',
    json: { username, password },
    auth: false,
  });
  const interim = findToken(body);
  if (!interim) throw new FactorCloudError('generate-token response did not include a token.', 502, body);
  return interim;
}

export async function completeLogin(interimToken: string, otpCode: string): Promise<string> {
  const body = await fcRequest('/authentications/login', {
    method: 'POST',
    json: {
      username: process.env.FACTORCLOUD_USERNAME,
      password: process.env.FACTORCLOUD_PASSWORD,
      otpCode,
    },
    token: interimToken,
  });
  const token = findToken(body);
  if (!token) throw new FactorCloudError('login response did not include a token.', 502, body);
  return token;
}

// ---------------------------------------------------------------------------
// Companies

export async function getCompany(id: string): Promise<CompanyRecord> {
  const body = await fcRequest(`/companies/${encodeURIComponent(id)}`);
  const record = unwrapRecord(body, ['company']);
  if (!record) throw new FactorCloudError(`Company ${id} response had no record.`, 502, body);
  return record as unknown as CompanyRecord;
}

function idList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Match an extracted debtor against FactorCloud.
 *
 * FactorCloud's company search endpoint isn't proven yet, so candidates come from
 * FACTORCLOUD_DEBTOR_IDS (comma-separated). Swap `debtorCandidates` for a search
 * call once one is confirmed; the scoring below stays the same.
 */
export async function findDebtor(
  hints: DebtorHints,
): Promise<{ debtor: CompanyRecord; method: string; score: number } | null> {
  const candidates = await Promise.all(idList(process.env.FACTORCLOUD_DEBTOR_IDS).map((id) => getCompany(id)));
  let best: { debtor: CompanyRecord; method: string; score: number } | null = null;
  for (const debtor of candidates) {
    const scored = scoreDebtor(hints, debtor);
    if (scored && (!best || scored.score > best.score)) best = { debtor, ...scored };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Invoice creation (sequence proven with Test003)

export interface NewInvoice {
  invoiceNumber: string;
  referenceNumber: string | null;
  companyClientId: string;
  companyDebtorId: string;
  invoiceAmount: number;
  invoiceDate: string; // YYYY-MM-DD
  notes: string | null;
}

export async function createInvoice(invoice: NewInvoice): Promise<{ id: string; raw: unknown }> {
  const body = await fcRequest('/invoices', {
    method: 'POST',
    json: {
      ...invoice,
      invoiceDate: `${invoice.invoiceDate}T00:00:00Z`,
      dueDate: null, // FactorCloud derives the due date from the client's terms
    },
  });
  const record = unwrapRecord(body, ['invoice']);
  if (!record) throw new FactorCloudError('Invoice created but the response had no invoice id.', 502, body);
  return { id: record.id as string, raw: body };
}

/** FactorCloud document type for each classified document. Only INVOICE is proven so far. */
export const FC_DOCUMENT_TYPES: Record<string, string> = {
  invoice: 'INVOICE',
  bol: 'BOL',
  pod: 'POD',
  rate_confirmation: 'RATE_CONFIRMATION',
  other: 'OTHER',
};

export async function uploadDocument(
  clientId: string,
  file: File,
  type: string,
): Promise<{ id: string; type: string }> {
  const attempt = async (t: string) => {
    const form = new FormData();
    form.append('file', file, file.name); // field name must be lowercase "file"
    const body = await fcRequest('/documents', {
      method: 'POST',
      query: { companyId: clientId, type: t, fileName: file.name },
      form,
    });
    const record = unwrapRecord(body, ['document']);
    if (!record) throw new FactorCloudError('Document uploaded but the response had no document id.', 502, body);
    return { id: record.id as string, type: t };
  };
  try {
    return await attempt(type);
  } catch (err) {
    // Unproven type names may be rejected; fall back to the one proven type.
    if (type !== 'INVOICE' && err instanceof FactorCloudError && err.status === 400) return attempt('INVOICE');
    throw err;
  }
}

export async function attachDocuments(invoiceId: string, documentIds: string[]): Promise<unknown> {
  return fcRequest(`/invoices/${encodeURIComponent(invoiceId)}`, {
    method: 'PUT',
    json: { documents: documentIds },
  });
}
