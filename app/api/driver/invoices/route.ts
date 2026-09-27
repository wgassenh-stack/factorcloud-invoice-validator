import { NextResponse } from 'next/server';
import { DEMO_DRIVER } from '@/lib/demo';
import { demoRequest } from '@/lib/demo-request';
import { demoDriverInvoices } from '@/lib/demo-store';

export const runtime = 'nodejs';

/**
 * The Driver view's invoice list. Demo only for now: real driver logins (each driver seeing only
 * what they sent in, enforced on the server) come later with database sign-in.
 */
export async function GET() {
  if (!(await demoRequest())) return NextResponse.json({ error: 'The Driver view is only available with demo data for now.' }, { status: 404 });
  return NextResponse.json({ driver: DEMO_DRIVER, invoices: demoDriverInvoices(DEMO_DRIVER) });
}
