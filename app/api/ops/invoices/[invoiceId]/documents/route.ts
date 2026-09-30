import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-errors';
import { demoRequest } from '@/lib/demo-request';
import { FactorCloudError, invoiceDocumentsUrl } from '@/lib/factorcloud';
import { requireFactorSession } from '@/lib/portal-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * An invoice's paperwork, as one PDF, for viewing beside the review evidence. The portal keeps no
 * copies: it asks FactorCloud for the invoice's combined documents with the factor's own access
 * and passes the file through for display. `?check=1` only says whether there is anything to show.
 */
export async function GET(req: Request, context: { params: Promise<{ invoiceId: string }> }) {
  try {
    await requireFactorSession();
    if (await demoRequest()) return NextResponse.json({ available: false, demo: true }, { status: 404 });
    const { invoiceId } = await context.params;
    let url: string | null;
    try { url = await invoiceDocumentsUrl(invoiceId); }
    catch (err) {
      if (err instanceof FactorCloudError && (err.status === 404 || err.status === 400)) url = null;
      else throw err;
    }
    if (!url) return NextResponse.json({ available: false, error: 'FactorCloud has no documents for this invoice yet.' }, { status: 404 });
    if (new URL(req.url).searchParams.get('check') === '1') return NextResponse.json({ available: true });
    const file = await fetch(url, { cache: 'no-store' });
    if (!file.ok || !file.body) return NextResponse.json({ available: false, error: `FactorCloud's document link didn't open (${file.status}). Try again.` }, { status: 502 });
    return new Response(file.body, {
      headers: {
        'Content-Type': file.headers.get('content-type') || 'application/pdf',
        'Content-Disposition': `inline; filename="invoice-${invoiceId.replace(/[^\w-]/g, '')}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return apiErrorResponse(err, 'ops-invoice-documents');
  }
}
