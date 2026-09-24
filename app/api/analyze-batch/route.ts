import { NextResponse } from 'next/server';
import { groupIntoInvoicePackets } from '@/lib/batch';
import { extractDocument, isSupportedFile } from '@/lib/extract';
import { FactorCloudError, getCompany } from '@/lib/factorcloud';
import { scoreDebtor } from '@/lib/matching';
import { validate } from '@/lib/rules';
import { applyFactorCloudAvailability } from '@/lib/validation-availability';
import type {
  AnalyzedDocument,
  BatchAnalyzeResponse,
  BatchPacketAnalysis,
  CompanyRecord,
} from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const MAX_FILES = 24;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const EXTRACTION_CONCURRENCY = 4;

export async function POST(req: Request) {
  const form = await req.formData();
  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: 'Upload at least one document.' }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Upload at most ${MAX_FILES} documents per batch for the pilot.` }, { status: 400 });
  if (files.some((f) => f.size > MAX_FILE_BYTES)) return NextResponse.json({ error: 'Each file must be 10 MB or smaller for the pilot.' }, { status: 413 });
  if (files.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) return NextResponse.json({ error: 'Combined upload must be 25 MB or smaller for the pilot.' }, { status: 413 });

  const unsupported = files.filter((f) => !isSupportedFile(f.type));
  if (unsupported.length) {
    return NextResponse.json({ error: `Unsupported file type: ${unsupported.map((f) => f.name).join(', ')}.` }, { status: 400 });
  }

  let documents: AnalyzedDocument[];
  try {
    documents = await mapLimit(files, EXTRACTION_CONCURRENCY, async (file) => {
      const result = await extractDocument(file);
      return { fileName: file.name, fields: result.fields, usage: result.usage };
    });
  } catch (err) {
    return NextResponse.json({ error: `Every uploaded file must be read before batch intake can continue. ${errorMessage(err)}` }, { status: 502 });
  }

  const grouped = groupIntoInvoicePackets(documents);
  const warnings: string[] = [];
  if (!grouped.packets.length) {
    warnings.push('No invoice documents were detected, so no invoice packets could be formed.');
  }
  if (grouped.unassignedDocuments.length) {
    warnings.push(`${grouped.unassignedDocuments.length} supporting document(s) could not be assigned confidently to a single invoice packet.`);
  }

  let client: CompanyRecord | null = null;
  let debtorCandidates: CompanyRecord[] = [];
  let factorCloudLookupFailed = false;
  try {
    const clientId = process.env.FACTORCLOUD_CLIENT_ID;
    if (!clientId) throw new FactorCloudError('FACTORCLOUD_CLIENT_ID is not configured.', 500, null);
    const debtorIds = idList(process.env.FACTORCLOUD_DEBTOR_IDS);
    [client, debtorCandidates] = await Promise.all([
      getCompany(clientId),
      Promise.all(debtorIds.map((id) => getCompany(id))),
    ]);
  } catch (err) {
    factorCloudLookupFailed = true;
    warnings.push(
      err instanceof FactorCloudError && err.status === 401
        ? 'Not signed in to FactorCloud. Sign in, then analyze the batch again.'
        : `FactorCloud lookup failed: ${errorMessage(err)}`,
    );
  }

  const packets: BatchPacketAnalysis[] = grouped.packets.map((packet) => {
    const match = factorCloudLookupFailed ? null : matchPacketDebtor(packet.documents, debtorCandidates);
    const debtor = match?.debtor ?? null;
    const rawValidation = validate({ documents: packet.documents, primaryIndex: packet.primaryIndex, debtor, client });
    const validation = applyFactorCloudAvailability(rawValidation, factorCloudLookupFailed);
    return {
      packetId: packet.packetId,
      documents: packet.documents,
      primaryIndex: packet.primaryIndex,
      debtor,
      debtorMatch: match ? { method: match.method, score: match.score } : null,
      client,
      factorCloudLookupFailed,
      validation,
      warnings: [],
    };
  });

  const body: BatchAnalyzeResponse = {
    packets,
    unassignedDocuments: grouped.unassignedDocuments,
    warnings,
  };
  return NextResponse.json(body);
}

function matchPacketDebtor(documents: AnalyzedDocument[], candidates: CompanyRecord[]) {
  const ordered = [
    ...documents.filter((d) => d.fields.documentType === 'invoice'),
    ...documents.filter((d) => d.fields.documentType !== 'invoice'),
  ];
  let best: { debtor: CompanyRecord; method: string; score: number } | null = null;
  for (const document of ordered) {
    for (const debtor of candidates) {
      const scored = scoreDebtor({
        name: document.fields.debtorName,
        ein: document.fields.debtorEin,
        phone: document.fields.debtorPhone,
      }, debtor);
      if (scored && (!best || scored.score > best.score)) best = { debtor, ...scored };
    }
  }
  return best;
}

function idList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
