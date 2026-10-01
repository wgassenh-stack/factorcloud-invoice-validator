import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { FactorCloudError } from '@/lib/errors';
import { completeLogin, cookieOptions, startLogin } from '@/lib/factorcloud';
import { canStoreToken, saveToken, storedToken } from '@/lib/factorcloud-connection';
import { requireFactorSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';
import { tokenExpiry } from '@/lib/token-expiry';

export const runtime = 'nodejs';

// Diagnostics → Reconnect FactorCloud. A factor admin signs in to FactorCloud with the emailed code
// and the new access token is saved (encrypted) for the whole portal, with no redeploy. The username
// and password are used for the sign-in only and never stored.

const INTERIM = 'fc_connect_interim';
const interimCookie = { ...cookieOptions(10 * 60), path: '/api/ops/factorcloud-connection' };

async function status(role: string) {
  const stored = await storedToken();
  const env = process.env.FACTORCLOUD_BEARER_TOKEN;
  return {
    connected: stored ? { expiresAt: stored.expiresAt, connectedBy: stored.connectedBy, connectedAt: stored.connectedAt } : null,
    setting: env ? { expiresAt: tokenExpiry(env)?.toISOString() ?? null } : null,
    canReconnect: role === 'FACTOR_ADMIN' && databaseAuthEnabled() && canStoreToken(),
    // The deployment can sign in by itself if it has a FactorCloud username and password; otherwise the admin types them.
    needsLogin: !(process.env.FACTORCLOUD_USERNAME && process.env.FACTORCLOUD_PASSWORD),
  };
}

export async function GET() {
  try {
    const session = await requireFactorSession();
    if (await demoRequest()) {
      return NextResponse.json({ demo: true, connected: { expiresAt: new Date(Date.now() + 5 * 86400000).toISOString(), connectedBy: 'Demo Admin', connectedAt: new Date(Date.now() - 2 * 86400000).toISOString() }, setting: null, canReconnect: false, needsLogin: true });
    }
    return NextResponse.json(await status(session.role));
  } catch (err) {
    return apiErrorResponse(err, 'factorcloud-connection-status');
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireFactorSession();
    if (await demoRequest()) return NextResponse.json({ error: 'Demo data is on: nothing connects to FactorCloud.' }, { status: 409 });
    if (!(await status(session.role)).canReconnect) {
      return NextResponse.json({ error: session.role !== 'FACTOR_ADMIN' ? 'Only a factor admin can reconnect FactorCloud.' : 'This deployment cannot store a FactorCloud connection: it needs database sign-in and AUTH_SESSION_SECRET.' }, { status: 403 });
    }
    const body = await req.json().catch(() => ({})) as { step?: string; code?: string; username?: string; password?: string };
    const given = { username: typeof body.username === 'string' ? body.username : undefined, password: typeof body.password === 'string' ? body.password : undefined };

    if (body.step === 'start') {
      let interim: string;
      try {
        interim = await startLogin(given);
      } catch (err) {
        if (err instanceof FactorCloudError && (err.status === 400 || err.status === 401 || err.status === 403)) {
          return NextResponse.json({ error: err.status === 400 && err.message.startsWith('Enter') ? err.message : 'FactorCloud didn\'t accept that username and password.' }, { status: 400 });
        }
        throw err;
      }
      const res = NextResponse.json({ ok: true, detail: 'FactorCloud emailed a sign-in code.' });
      res.cookies.set(INTERIM, interim, interimCookie);
      return res;
    }

    if (body.step === 'verify') {
      const interim = (await cookies()).get(INTERIM)?.value;
      if (!interim) return NextResponse.json({ error: 'The sign-in timed out. Start again to get a new code.' }, { status: 400 });
      const code = body.code?.trim();
      if (!code) return NextResponse.json({ error: 'Enter the code from the email.' }, { status: 400 });
      let token: string;
      try {
        token = await completeLogin(interim, code, given);
      } catch (err) {
        if (err instanceof FactorCloudError && (err.status === 400 || err.status === 401 || err.status === 403)) {
          return NextResponse.json({ error: 'That code didn\'t work or has expired. Check it, or start again for a new one.' }, { status: 400 });
        }
        throw err;
      }
      await saveToken(token, { userId: session.userId, name: session.displayName || session.email });
      const res = NextResponse.json({ ok: true, ...(await status(session.role)) });
      res.cookies.set(INTERIM, '', { ...interimCookie, maxAge: 0 });
      return res;
    }

    return NextResponse.json({ error: 'Unknown step.' }, { status: 400 });
  } catch (err) {
    return apiErrorResponse(err, 'factorcloud-connection', 502);
  }
}
