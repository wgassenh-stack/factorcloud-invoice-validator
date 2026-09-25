import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { INTERIM_COOKIE, cookieOptions, startLogin } from '@/lib/factorcloud';

export const runtime = 'nodejs';

export async function POST() {
  if (process.env.ALLOW_INTERACTIVE_FACTORCLOUD_LOGIN !== 'true') {
    return NextResponse.json({ error: 'Interactive FactorCloud staff login is disabled for this client portal.' }, { status: 403 });
  }
  try {
    const interim = await startLogin();
    const res = NextResponse.json({ ok: true });
    res.cookies.set(INTERIM_COOKIE, interim, cookieOptions(10 * 60));
    return res;
  } catch (err) {
    return apiErrorResponse(err, 'factorcloud-login-start', 502);
  }
}
