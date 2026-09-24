export function unwrapRecord(body: unknown, keys: string[] = []): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [body];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      if (cur.length === 1) queue.push(cur[0]);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (typeof obj.id === 'string') return obj;
    for (const k of [...keys, 'data', 'result', 'results', 'item', 'items']) {
      if (k in obj) queue.push(obj[k]);
    }
  }
  return null;
}

export function findToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  for (const k of ['token', 'accessToken', 'access_token', 'idToken', 'jwt', 'bearerToken', 'authToken']) {
    if (typeof obj[k] === 'string' && obj[k]) return obj[k] as string;
  }
  for (const k of ['data', 'result', 'authentication', 'auth']) {
    const found = findToken(obj[k]);
    if (found) return found;
  }
  return null;
}

export interface InvoiceSummary {
  id: string;
  invoiceNumber?: string | null;
  companyClientId?: string | null;
  companyDebtorId?: string | null;
  status?: string | null;
}

export function collectInvoiceRecords(body: unknown): InvoiceSummary[] {
  const out: InvoiceSummary[] = [];
  const seen = new Set<unknown>();
  const walk = (cur: unknown) => {
    if (!cur || typeof cur !== 'object' || seen.has(cur)) return;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) walk(item);
      return;
    }
    const obj = cur as Record<string, unknown>;
    if (typeof obj.id === 'string' && typeof obj.invoiceNumber === 'string') {
      out.push({
        id: obj.id,
        invoiceNumber: obj.invoiceNumber as string,
        companyClientId: typeof obj.companyClientId === 'string' ? obj.companyClientId : null,
        companyDebtorId: typeof obj.companyDebtorId === 'string' ? obj.companyDebtorId : null,
        status: typeof obj.status === 'string' ? obj.status : null,
      });
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(body);
  const byId = new Map(out.map((x) => [x.id, x]));
  return [...byId.values()];
}
