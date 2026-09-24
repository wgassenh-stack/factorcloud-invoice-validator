import { NextResponse } from 'next/server';
import { INTERIM_COOKIE, cookieOptions, startLogin } from '@/lib/factorcloud';

export const runtime = 'nodejs';

/** Step 1 of the OTP flow: FactorCloud emails a code and returns an interim token. */
export async function POST() {
  try {
    const interim = await startLogin();
    const res = NextResponse.json({ ok: true });
    res.cookies.set(INTERIM_COOKIE, interim, cookieOptions(10 * 60));
    return res;
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

