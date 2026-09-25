import { NextResponse } from 'next/server';
import { compare } from 'bcryptjs';
import { apiErrorResponse } from '@/lib/api-errors';
import { clearLoginFailures, clientIp, lockedUntil, recordLoginFailure, throttleBuckets } from '@/lib/login-throttle';
import { findLoginUser, touchLogin, userClients } from '@/lib/portal-auth';
import { databaseAuthEnabled, PORTAL_SESSION_COOKIE, signPortalSession } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!databaseAuthEnabled()) {
    return NextResponse.json({ error: 'Database authentication is not enabled.' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({})) as { email?: string; password?: string };
  const email = body.email?.trim() || '';
  const password = body.password || '';
  if (!email || !password) return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });

  try {
    // Checked before the password so a locked account cannot be probed.
    const buckets = throttleBuckets(email, clientIp(req.headers));
    const until = await lockedUntil(buckets);
    if (until) {
      const retryAfter = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000));
      return NextResponse.json(
        { error: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      );
    }

    const user = await findLoginUser(email);
    const valid = Boolean(user?.is_active && user.password_hash && await compare(password, user.password_hash));
    if (!user || !valid) {
      await recordLoginFailure(buckets);
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
    }
    await clearLoginFailures(buckets);

    const clients = user.role === 'CLIENT_USER' ? await userClients(user.id) : [];
    if (user.role === 'CLIENT_USER' && clients.length !== 1) {
      return NextResponse.json({ error: 'This account is not assigned to exactly one active client portal.' }, { status: 403 });
    }

    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    const token = await signPortalSession({
      v: 1,
      userId: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      factorId: user.factor_id,
      clients: clients.map((client) => ({ id: client.id, factorCloudClientId: client.factorcloud_client_id, name: client.name })),
      exp: expiresAt,
    });

    await touchLogin(user.id);
    const res = NextResponse.json({
      ok: true,
      user: { email: user.email, displayName: user.display_name, role: user.role },
      redirectTo: user.role === 'CLIENT_USER' ? '/' : '/ops',
    });
    res.cookies.set(PORTAL_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60,
    });
    return res;
  } catch (err) {
    return apiErrorResponse(err, 'login');
  }
}
