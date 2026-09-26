import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { listClientTasks } from '@/lib/client-tasks';
import { demoRequest } from '@/lib/demo-request';
import { demoClientTasks } from '@/lib/demo-store';
import { currentPortalSession, resolveConfiguredClientId } from '@/lib/portal-auth';
import { databaseAuthEnabled } from '@/lib/session';

export const runtime = 'nodejs';

/** The signed-in client's open fix requests. */
export async function GET() {
  try {
    const clientId = await resolveConfiguredClientId();
    if (await demoRequest()) {
      return NextResponse.json({ tasks: demoClientTasks(clientId).map(({ files: _files, reviewId: _reviewId, clientId: _clientId, ...task }) => task) });
    }
    // Fix requests live in the portal database, so there are none without database sign-in.
    if (!databaseAuthEnabled()) return NextResponse.json({ tasks: [] });
    const session = await currentPortalSession();
    if (!session) return NextResponse.json({ tasks: [] });
    return NextResponse.json({ tasks: await listClientTasks(session.factorId, clientId) });
  } catch (err) {
    return apiErrorResponse(err, 'client-tasks');
  }
}
