import { NextResponse } from 'next/server';
import { extractDocument, isSupportedFile } from '@/lib/extract';
import { FactorCloudError, findDebtor, getCompany } from '@/lib/factorcloud';
import { validate } from '@/lib/rules';
import { applyFactorCloudAvailability } from '@/lib/validation-availability';
import type { AnalyzeResponse, AnalyzedDocument, CompanyRecord } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_FILES = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const form = await req.formData();
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: 'Upload at least one document.' }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Upload at most ${MAX_FILES} documents.` }, { status: 400 });
  if (files.some((f) => f.size > MAX_FILE_BYTES)) return NextResponse.json({ error: 'Each file must be 10 MB or smaller for the pilot.' }, { status: 413 });
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) return NextResponse.json({ error: 'Combined upload must be 25 MB or smaller for the pilot.' }, { status: 413 });

  const unsupported = files.filter((f) => !isSupportedFile(f.type));
  if (unsupported.length) {
    return NextResponse.json({ error: `Unsupported file type: ${unsupported.map((f) => f.name).join(', ')}. Use PDF, PNG, JPEG, GIF or WebP.` }, { status: 400 });
  }

  const settled = await Promise.allSettled(files.map((f) => extractDocument(f)));
  const extractionErrors = settled.flatMap((r, i) =>
    r.status === 'rejected' ? [`Could not read ${files[i].name}: ${errorMessage(r.reason)}`] : [],
  );
  if (extractionErrors.length) {
    return NextResponse.json(
      { error: `Every uploaded file must be read before this packet can continue. ${extractionErrors.join(' ')}` },
      { status: 502 },
    );
  }

  const documents: AnalyzedDocument[] = settled.map((r, i) => {
    const result = (r as PromiseFulfilledResult<Awaited<ReturnType<typeof extractDocument>>>).value;
    return { fileName: files[i].name, fields: result.fields, usage: result.usage };
  });
  const warnings: string[] = [];

  const invoiceIndex = documents.findIndex((d) => d.fields.documentType === 'invoice');
  const primaryIndex = invoiceIndex >= 0 ? invoiceIndex : 0;
  if (invoiceIndex < 0) warnings.push('No invoice was detected. Creation will stay blocked until an invoice is identified.');

  let debtor: CompanyRecord | null = null;
  let debtorMatch: AnalyzeResponse['debtorMatch'] = null;
  let client: CompanyRecord | null = null;
  let factorCloudLookupFailed = false;
  try {
    const ordered = [documents[primaryIndex], ...documents.filter((_, i) => i !== primaryIndex)];
    for (const d of ordered) {
      const match = await findDebtor({ name: d.fields.debtorName, ein: d.fields.debtorEin, phone: d.fields.debtorPhone });
      if (match) {
        debtor = match.debtor;
        debtorMatch = { method: match.method, score: match.score };
        break;
      }
    }
    const clientId = process.env.FACTORCLOUD_CLIENT_ID;
    if (clientId) client = await getCompany(clientId);
    else warnings.push('FACTORCLOUD_CLIENT_ID is not configured.');
  } catch (err) {
    factorCloudLookupFailed = true;
    warnings.push(
      err instanceof FactorCloudError && err.status === 401
        ? 'Not signed in to FactorCloud. Sign in, then analyze again to compare against FactorCloud data.'
        : 'FactorCloud is temporarily unavailable. The document-to-document checks below are still valid, but retry analysis before creating the invoice.',
    );
  }

  const validation = applyFactorCloudAvailability(
    validate({ documents, primaryIndex, debtor, client }),
    factorCloudLookupFailed,
  );
  const body: AnalyzeResponse = {
    documents,
    primaryIndex,
    debtor,
    debtorMatch,
    client,
    factorCloudLookupFailed,
    validation,
    warnings,
  };
  return NextResponse.json(body);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
