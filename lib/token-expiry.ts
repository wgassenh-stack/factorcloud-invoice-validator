// When a FactorCloud access token stops working, read from the token itself. Only the expiry is
// read: the token is not verified here (FactorCloud does that) and its value is never reported.

/** The expiry of a JWT-style token, or null when the token doesn't carry one. */
export function tokenExpiry(token: string | null | undefined): Date | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A plain-language check of the service token's expiry, for Diagnostics. */
export function tokenExpiryCheck(token: string | null | undefined, now = new Date()): { state: 'ok' | 'warn' | 'fail' | 'skip'; detail: string } {
  if (!token) return { state: 'skip', detail: 'No service token is set.' };
  const expires = tokenExpiry(token);
  if (!expires) return { state: 'skip', detail: 'The token does not say when it expires. If FactorCloud data stops loading with a sign-in error, replace FACTORCLOUD_BEARER_TOKEN and redeploy.' };
  const when = expires.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: process.env.FACTOR_TIMEZONE || 'America/Chicago' });
  const left = expires.getTime() - now.getTime();
  if (left <= 0) return { state: 'fail', detail: `The token expired on ${when}. Replace FACTORCLOUD_BEARER_TOKEN with a new one and redeploy.` };
  if (left < 7 * DAY_MS) {
    const hours = Math.round(left / (60 * 60 * 1000));
    return { state: 'warn', detail: `The token expires ${hours < 48 ? `in ${hours} hour${hours === 1 ? '' : 's'}` : `in ${Math.round(left / DAY_MS)} days`} (${when}). Replace FACTORCLOUD_BEARER_TOKEN before then and redeploy.` };
  }
  return { state: 'ok', detail: `The token is good until ${when}.` };
}
