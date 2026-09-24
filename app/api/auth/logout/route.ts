import { NextResponse } from 'next/server';
import { INTERIM_COOKIE, TOKEN_COOKIE } from '@/lib/factorcloud';

export const runtime = 'nodejs';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(TOKEN_COOKIE);
  res.cookies.delete(INTERIM_COOKIE);
  return res;
}
