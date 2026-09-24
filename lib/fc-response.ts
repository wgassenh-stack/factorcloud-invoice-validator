// Helpers for reading FactorCloud responses whose envelope shapes aren't documented.

/**
 * FactorCloud wraps records in varying envelopes ({ data: {...} }, { invoice: {...} }, ...).
 * Find the first object that has an `id`, looking through the usual wrapper keys.
 */
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

/** Find a token string in an auth response without knowing the exact field name. */
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
