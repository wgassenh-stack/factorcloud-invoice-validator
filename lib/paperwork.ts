import 'server-only';

import { FactorCloudError, allowedDebtorIds, getCompany } from './factorcloud';
import { scoreDebtor } from './matching';
import { validate } from './rules';
import { applyFactorCloudAvailability } from './validation-availability';
import { hashFile, signAnalysisReceipt } from './submission-integrity';
import { extractDocument, isSupportedFile } from './extract';
import type { AnalyzeResponse, AnalyzedDocument, CompanyRecord } from './types';

// Checks each group of an upload as its own invoice: match the debtor, run the checks, and sign a
// receipt the create step verifies. Used when the paperwork is first read
// and again whenever someone moves a document to a different group (no re-reading needed).

/** One group of documents, checked as one invoice. Same shape the invoice create step expects. */
export interface PaperworkCard extends AnalyzeResponse {
  id: string;
  /** Positions of this card's documents in the upload, in the order the files must be sent. */
  documentIndexes: number[];
}

export interface SkippedFile {
  fileName: string;
  /** Position of the file in the browser's list. */
  fileIndex: number;
  reason: string;
}

export interface PaperworkResponse {
  documents: AnalyzedDocument[];
  /** Signed copy of everything read, sent back for re-checks. */
  documentsReceipt: string;
  cards: PaperworkCard[];
  unassigned: number[];
  /** Likely homes for each unplaced document (its invoice document's position), best first. */
  suggestions: Record<number, number[]>;
  /** Files that couldn't be read; everything else carries on. */
  unreadable: SkippedFile[];
  /** Files uploaded twice; only the first copy is used. */
  duplicates: SkippedFile[];
  warnings: string[];
}

/**
 * Reads uploaded files. The same file twice is read once; a file that can't be read is reported
 * rather than failing the whole upload. `firstIndex` is where these files start in the browser's
 * list, so each document can point back at its file.
 */
export async function readFiles(files: File[], firstIndex: number, knownHashes: string[] = [], concurrency = 4): Promise<{ documents: AnalyzedDocument[]; fileIndexes: number[]; unreadable: SkippedFile[]; duplicates: SkippedFile[] }> {
  const hashes = await Promise.all(files.map((file) => hashFile(file)));
  const seen = new Map<string, string>(knownHashes.map((h) => [h, 'a file already uploaded']));
  const duplicates: SkippedFile[] = [];
  const toRead: number[] = [];
  hashes.forEach((hash, i) => {
    const earlier = seen.get(hash);
    if (earlier) duplicates.push({ fileName: files[i].name, fileIndex: firstIndex + i, reason: `Same file as ${earlier}.` });
    else { seen.set(hash, files[i].name); toRead.push(i); }
  });

  const results = new Array<AnalyzedDocument | Error>(toRead.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, toRead.length) }, async () => {
    while (next < toRead.length) {
      const slot = next++;
      const file = files[toRead[slot]];
      try {
        const read = await extractDocument(file);
        results[slot] = { fileName: file.name, fields: read.fields, usage: read.usage };
      } catch (err) {
        results[slot] = err instanceof Error ? err : new Error(String(err));
      }
    }
  }));

  const documents: AnalyzedDocument[] = [];
  const fileIndexes: number[] = [];
  const unreadable: SkippedFile[] = [];
  results.forEach((result, slot) => {
    const i = toRead[slot];
    if (result instanceof Error) unreadable.push({ fileName: files[i].name, fileIndex: firstIndex + i, reason: 'We could not read this file. Retake the photo or upload a clearer copy.' });
    else { documents.push({ ...result, fileHash: hashes[i], sourceIndex: firstIndex + i, sizeBytes: files[i].size }); fileIndexes.push(firstIndex + i); }
  });
  return { documents, fileIndexes, unreadable, duplicates };
}

export async function checkCards(clientId: string, documents: AnalyzedDocument[], groups: { id: string; documentIndexes: number[] }[]): Promise<{ cards: PaperworkCard[]; warnings: string[] }> {
  const warnings: string[] = [];
  let client: CompanyRecord | null = null;
  let candidates: CompanyRecord[] = [];
  let lookupFailed = false;
  if (groups.length) {
    try {
      const ids = await allowedDebtorIds();
      const settled = await Promise.allSettled(ids.map((id) => getCompany(id)));
      candidates = settled.flatMap((r) => r.status === 'fulfilled' ? [r.value] : []);
      client = await getCompany(clientId);
    } catch (err) {
      lookupFailed = true;
      warnings.push(err instanceof FactorCloudError && err.status === 401
        ? 'FactorCloud connection is unavailable. Contact your factor and try again.'
        : 'FactorCloud is temporarily unavailable. The document checks below still hold, but check again before sending.');
    }
  }

  const cards = await Promise.all(groups.map(async (group) => {
    // Invoice first: it is the document the invoice is created from.
    const ordered = orderInvoiceFirst(group.documentIndexes, documents);
    const docs = ordered.map((i) => documents[i]);
    const primaryIndex = 0;
    const match = lookupFailed ? null : matchDebtor(docs, candidates);
    const debtor = match?.debtor ?? null;
    // No credit check here: credit limits are the factor's business. It runs when the invoice is
    // sent, and only the approver sees the result.
    const validation = applyFactorCloudAvailability(validate({ documents: docs, primaryIndex, debtor, client }), lookupFailed);
    const cardWarnings = docs[primaryIndex].fields.documentType === 'invoice' ? [] : ['No invoice in this group. Add the invoice, or move these documents to the group they belong to.'];
    const card: PaperworkCard = {
      id: group.id,
      documentIndexes: ordered,
      documents: docs,
      primaryIndex,
      debtor,
      debtorMatch: match ? { method: match.method, score: match.score } : null,
      client,
      factorCloudLookupFailed: lookupFailed,
      validation,
      warnings: cardWarnings,
      credit: null,
      analysisReceipt: signAnalysisReceipt({ version: 1, clientId, debtorId: debtor?.id ?? null, primaryIndex, documents: docs }),
    };
    return card;
  }));
  return { cards, warnings };
}

function orderInvoiceFirst(indexes: number[], documents: AnalyzedDocument[]): number[] {
  const invoice = indexes.find((i) => documents[i].fields.documentType === 'invoice');
  return invoice == null ? indexes.slice() : [invoice, ...indexes.filter((i) => i !== invoice)];
}

function matchDebtor(documents: AnalyzedDocument[], candidates: CompanyRecord[]) {
  let best: { debtor: CompanyRecord; method: string; score: number } | null = null;
  for (const document of documents) {
    for (const debtor of candidates) {
      const scored = scoreDebtor({ name: document.fields.debtorName, ein: document.fields.debtorEin, phone: document.fields.debtorPhone }, debtor);
      if (scored && (!best || scored.score > best.score)) best = { debtor, ...scored };
    }
  }
  return best;
}

const MAX_FILES = 24;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * Upload limits, shared by reading and adding documents. `already` is what the package holds so
 * far, so adding documents later can't grow it past the same limits in small steps.
 */
export function uploadProblem(files: File[], already: { count: number; bytes: number } = { count: 0, bytes: 0 }): { message: string; status: number } | null {
  if (!files.length) return { message: 'Add at least one document or photo.', status: 400 };
  if (files.length + already.count > MAX_FILES) return { message: `Send at most ${MAX_FILES} documents at a time.`, status: 400 };
  if (files.some((f) => f.size > MAX_FILE_BYTES)) return { message: 'Each file must be 10 MB or smaller.', status: 413 };
  if (files.reduce((sum, f) => sum + f.size, already.bytes) > MAX_TOTAL_BYTES) return { message: already.count ? 'This would take the paperwork over 25 MB in total. Send these invoices first, then start a new upload.' : 'All files together must be 25 MB or smaller.', status: 413 };
  const unsupported = files.filter((f) => !isSupportedFile(f.type));
  if (unsupported.length) return { message: `Unsupported file type: ${unsupported.map((f) => f.name).join(', ')}. Use PDF, PNG, JPEG, GIF or WebP.`, status: 400 };
  return null;
}
