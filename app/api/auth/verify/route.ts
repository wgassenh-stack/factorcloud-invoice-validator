import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { INTERIM_COOKIE, TOKEN_COOKIE, completeLogin, cookieOptions } from '@/lib/factorcloud';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (process.env.ALLOW_INTERACTIVE_FACTORCLOUD_LOGIN !== 'true') {
    return NextResponse.json({ error: 'Interactive FactorCloud staff login is disabled for this client portal.' }, { status: 403 });
  }
  const { otp } = (await req.json().catch(() => ({}))) as { otp?: string };
  const jar = await cookies();
  const interim = jar.get(INTERIM_COOKIE)?.value;
  if (!interim) return NextResponse.json({ error: 'Sign-in expired. Request a new code.' }, { status: 400 });
  if (!otp?.trim()) return NextResponse.json({ error: 'Enter the code from the email.' }, { status: 400 });
  try {
    const token = await completeLogin(interim, otp.trim());
    const res = NextResponse.json({ ok: true });
    res.cookies.set(TOKEN_COOKIE, token, cookieOptions(8 * 60 * 60));
    res.cookies.delete(INTERIM_COOKIE);
    return res;
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
