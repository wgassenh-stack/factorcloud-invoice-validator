import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { currentValidPortalSession } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';

export async function GET() {
  if (!databaseAuthEnabled()) return NextResponse.json({ mode: 'pilot', authenticated: false });
  let session;
  try { session = await currentValidPortalSession(); }
  catch (err) { return apiErrorResponse(err, 'portal-session'); }
  if (!session) return NextResponse.json({ mode: 'database', authenticated: false });
  return NextResponse.json({
    mode: 'database',
    authenticated: true,
    user: {
      email: session.email,
      displayName: session.displayName,
      role: session.role,
      clients: session.clients,
    },
  });
}
