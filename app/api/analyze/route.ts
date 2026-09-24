import { NextResponse } from 'next/server';
import { extractDocument, isSupportedFile } from '@/lib/extract';
import { FactorCloudError, findDebtor, getCompany } from '@/lib/factorcloud';
import { validate } from '@/lib/rules';
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

  const warnings: string[] = [];
  const settled = await Promise.allSettled(files.map((f) => extractDocument(f)));
  const documents: AnalyzedDocument[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') documents.push({ fileName: files[i].name, fields: r.value });
    else warnings.push(`Could not read ${files[i].name}: ${errorMessage(r.reason)}`);
  });
  if (!documents.length) return NextResponse.json({ error: warnings.join(' ') }, { status: 502 });

  const invoiceIndex = documents.findIndex((d) => d.fields.documentType === 'invoice');
  const primaryIndex = invoiceIndex >= 0 ? invoiceIndex : 0;
  if (invoiceIndex < 0) warnings.push('No invoice was detected. Creation will stay blocked until an invoice is identified.');

  let debtor: CompanyRecord | null = null;
  let debtorMatch: AnalyzeResponse['debtorMatch'] = null;
  let client: CompanyRecord | null = null;
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
    warnings.push(
      err instanceof FactorCloudError && err.status === 401
        ? 'Not signed in to FactorCloud. Sign in, then analyze again to compare against FactorCloud data.'
        : `FactorCloud lookup failed: ${errorMessage(err)}`,
    );
  }

  const validation = validate({ documents, primaryIndex, debtor, client });
  const body: AnalyzeResponse = { documents, primaryIndex, debtor, debtorMatch, client, validation, warnings };
  return NextResponse.json(body);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
