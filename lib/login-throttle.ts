import { createHash } from 'crypto';
import { query } from './db';

// Database-backed login throttling. Two independent buckets per attempt:
//  - the email (hashed, so addresses that are not users are never stored), which stops guessing
//    one account's password;
//  - the client IP, which slows one source spraying many accounts.
// A bucket that reaches its failure limit within the window is locked for LOCK_MINUTES.

export const WINDOW_MINUTES = 15;
export const LOCK_MINUTES = 15;
export const EMAIL_MAX_FAILURES = 5;
export const IP_MAX_FAILURES = 25;

export interface ThrottleBucket {
  bucket: string;
  maxFailures: number;
}

export function throttleBuckets(email: string, ip: string | null): ThrottleBucket[] {
  const emailHash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  const buckets: ThrottleBucket[] = [{ bucket: `email:${emailHash}`, maxFailures: EMAIL_MAX_FAILURES }];
  if (ip) buckets.push({ bucket: `ip:${ip}`, maxFailures: IP_MAX_FAILURES });
  return buckets;
}

/**
 * The client IP as reported by the hosting proxy (first `x-forwarded-for` entry, else `x-real-ip`).
 * Only trustworthy behind a proxy that sets these headers itself, as Vercel does. Elsewhere the
 * per-email bucket still applies.
 */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || headers.get('x-real-ip')?.trim() || '';
  return ip && ip.length <= 64 ? ip : null;
}

/** When any bucket is locked, the time the lock ends; otherwise null. */
export async function lockedUntil(buckets: ThrottleBucket[]): Promise<Date | null> {
  const rows = await query<{ locked_until: Date }>(
    'select max(locked_until) as locked_until from auth_throttle where bucket = any($1::text[]) and locked_until > now()',
    [buckets.map((b) => b.bucket)],
  );
  return rows[0]?.locked_until ?? null;
}

export async function recordLoginFailure(buckets: ThrottleBucket[]): Promise<void> {
  for (const { bucket, maxFailures } of buckets) {
    // Atomic per bucket: restart the window if it has expired, count the failure, lock at the limit.
    await query(`
      insert into auth_throttle as t (bucket, failures, window_started_at, locked_until, updated_at)
      values ($1, 1, now(), case when 1 >= $2 then now() + make_interval(mins => $4) end, now())
      on conflict (bucket) do update set
        failures = case when t.window_started_at < now() - make_interval(mins => $3) then 1 else t.failures + 1 end,
        window_started_at = case when t.window_started_at < now() - make_interval(mins => $3) then now() else t.window_started_at end,
        locked_until = case
          when (case when t.window_started_at < now() - make_interval(mins => $3) then 1 else t.failures + 1 end) >= $2
            then now() + make_interval(mins => $4)
          else t.locked_until
        end,
        updated_at = now()
    `, [bucket, maxFailures, WINDOW_MINUTES, LOCK_MINUTES]);
  }
  // Housekeeping: forget buckets that have been quiet for a day and are not locked.
  await query(`delete from auth_throttle where updated_at < now() - interval '1 day' and (locked_until is null or locked_until < now())`);
}

/** A successful sign-in clears that account's failures. The IP bucket is left to expire. */
export async function clearLoginFailures(buckets: ThrottleBucket[]): Promise<void> {
  const emailBuckets = buckets.filter((b) => b.bucket.startsWith('email:')).map((b) => b.bucket);
  if (emailBuckets.length) await query('delete from auth_throttle where bucket = any($1::text[])', [emailBuckets]);
}
