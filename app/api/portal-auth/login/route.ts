import { NextResponse } from 'next/server';
import { compare } from 'bcryptjs';
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
    const user = await findLoginUser(email);
    const valid = Boolean(user?.is_active && user.password_hash && await compare(password, user.password_hash));
    if (!user || !valid) return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });

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
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
