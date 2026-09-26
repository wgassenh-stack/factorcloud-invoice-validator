import { NextResponse } from 'next/server';
import { DEMO_COOKIE, demoMode, demoToggleEnabled } from '@/lib/demo';

export const runtime = 'nodejs';

/** Turns demo data on or off for this browser only. */
export async function POST(req: Request) {
  if (!demoToggleEnabled()) return NextResponse.json({ error: 'Demo mode is not available on this site.' }, { status: 404 });
  const body = await req.json().catch(() => ({})) as { on?: boolean };
  const on = body.on === true;
  const res = NextResponse.json({ on: on || demoMode(), locked: demoMode() });
  // Readable by the page (not httpOnly) so the badge and switch can show the current state. It
  // holds no secret: it only chooses fake data over real data.
  if (on) res.cookies.set(DEMO_COOKIE, '1', { path: '/', sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 30 });
  else res.cookies.delete(DEMO_COOKIE);
  return res;
}
