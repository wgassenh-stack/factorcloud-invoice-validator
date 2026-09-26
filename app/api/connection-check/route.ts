import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { runConnectionCheck } from '@/lib/connection-check';
import { demoRequest } from '@/lib/demo-request';
import { requireFactorSession, resolveConfiguredClientId } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * Read-only FactorCloud connection check. With database sign-in it is for factor staff and covers
 * the whole factor; otherwise (shared password) it covers the configured client.
 */
export async function GET() {
  try {
    const demo = await demoRequest();
    if (databaseAuthEnabled() && !demo) {
      await requireFactorSession();
      const report = await runConnectionCheck({ clientId: process.env.FACTORCLOUD_CLIENT_ID || null, scope: 'factor' });
      return NextResponse.json({ ...report, demo });
    }
    const clientId = await resolveConfiguredClientId();
    return NextResponse.json({ ...(await runConnectionCheck({ clientId, scope: 'client' })), demo });
  } catch (err) {
    return apiErrorResponse(err, 'connection-check', 502);
  }
}
