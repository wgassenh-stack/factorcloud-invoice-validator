import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { listInvoices } from '@/lib/factorcloud';
import { notifyInvoiceProgress } from '@/lib/progress-notify';
import { collectRiskInvoiceRecords } from '@/lib/risk';
import { timingSafeEqual } from 'crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Daily check for funded/paid invoices to email clients about (vercel.json schedules it). Vercel
 * Cron sends `Authorization: Bearer $CRON_SECRET`; without CRON_SECRET set the route is disabled.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!secret || supplied.length !== secret.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  try {
    const list = await listInvoices();
    const sent = await notifyInvoiceProgress(collectRiskInvoiceRecords(list.raw));
    return NextResponse.json({ ok: true, sent, complete: list.complete });
  } catch (err) {
    return apiErrorResponse(err, 'cron-notifications', 502);
  }
}
