// Invoke from a scheduler with secrets supplied by its environment. Never prints the bearer token.
const base = process.env.PORTAL_PUBLIC_URL;
const secret = process.env.NOTIFICATION_WORKER_SECRET;
if (!base || new URL(base).protocol !== 'https:' || !secret) {
  throw new Error('HTTPS PORTAL_PUBLIC_URL and NOTIFICATION_WORKER_SECRET are required.');
}
const response = await fetch(new URL('/api/internal/notifications', base), {
  method: 'POST',
  redirect: 'error',
  headers: { Authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(55000),
});
if (!response.ok) throw new Error(`Notification worker returned HTTP ${response.status}.`);
const result = await response.json();
console.log(JSON.stringify({ sent: result.sent, failed: result.failed, disabled: result.disabled ?? false }));
