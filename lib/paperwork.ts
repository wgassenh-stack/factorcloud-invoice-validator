import 'server-only';

import { FactorCloudError, allowedDebtorIds, getCompany } from './factorcloud';
import { scoreDebtor } from './matching';
import { validate } from './rules';
import { applyFactorCloudAvailability } from './validation-availability';
import { hashFile, signAnalysisReceipt } from './submission-integrity';
import { extractDocument, isSupportedFile, readerRefusal, readerRetryAfterMs, transientGeminiError } from './extract';
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
  /** The reader was busy rather than the file being unreadable: trying again may well work. */
  retryable?: boolean;
}

export interface ReadOptions {
  concurrency?: number;
  /** Pauses before each retry of a file that failed to read. */
  retryDelaysMs?: number[];
  /** For tests: stands in for the document reader. */
  extract?: (file: File) => Promise<{ fields: AnalyzedDocument['fields']; usage: AnalyzedDocument['usage'] }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Longest wait we'll accept from the reader before giving up on this try. */
const MAX_READER_WAIT_MS = 30_000;

type ReadResult = { fields: AnalyzedDocument['fields']; usage: AnalyzedDocument['usage'] };

// Files already read, by content hash. The same paperwork uploaded again (a retry, "Start over",
// a second run-through of a demo) is answered instantly instead of asking the reader again.
const readCache: Map<string, ReadResult> = ((globalThis as unknown as { __fcReadCache?: Map<string, ReadResult> }).__fcReadCache ??= new Map());
const READ_CACHE_LIMIT = 500;

function remember(hash: string, result: ReadResult): void {
  if (readCache.size >= READ_CACHE_LIMIT) readCache.delete(readCache.keys().next().value!);
  readCache.set(hash, result);
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
export async function readFiles(files: File[], firstIndex: number, knownHashes: string[] = [], options: ReadOptions = {}): Promise<{ documents: AnalyzedDocument[]; fileIndexes: number[]; unreadable: SkippedFile[]; duplicates: SkippedFile[] }> {
  // Fewer at once, and patient retries: the reader sometimes refuses a burst of requests
  // ("too many requests", "busy"), which says nothing about the file itself.
  const { concurrency = 3, retryDelaysMs = [2000, 5000, 10000], extract } = options;
  const read = extract ?? extractDocument;
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
  // When the reader says it's busy, every worker backs off, not just the one that was refused:
  // piling more requests onto a rate limit only keeps it tripped.
  let pausedUntil = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, toRead.length) }, async () => {
    while (next < toRead.length) {
      const slot = next++;
      const file = files[toRead[slot]];
      // The reader is also shown the file name, so it is part of what was read.
      const hash = `${hashes[toRead[slot]]}:${file.name}`;
      const cached = extract ? undefined : readCache.get(hash);
      if (cached) {
        results[slot] = { fileName: file.name, fields: cached.fields, usage: cached.usage && { ...cached.usage, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, estimatedCostUsd: 0 } };
        continue;
      }
      for (let attempt = 0; ; attempt++) {
        if (pausedUntil > Date.now()) await sleep(pausedUntil - Date.now());
        try {
          const done = await read(file);
          if (!extract) remember(hash, done);
          results[slot] = { fileName: file.name, fields: done.fields, usage: done.usage };
          break;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const busy = transientGeminiError(error);
          const askedWait = busy ? readerRetryAfterMs(error) : null;
          // A busy reader gets every retry; any other failure gets one more try. A used-up daily
          // allowance won't come back in seconds, so it isn't retried at all.
          if (attempt >= retryDelaysMs.length || (attempt >= 1 && !busy) || (askedWait ?? 0) > MAX_READER_WAIT_MS || readerRefusal(error) === 'daily-limit') {
            console.error(`[paperwork] could not read ${file.name} after ${attempt + 1} tries:`, error.message);
            results[slot] = error;
            break;
          }
          const base = Math.max(retryDelaysMs[attempt], askedWait ?? 0);
          const wait = base ? base + Math.round(Math.random() * base * 0.25) : 0;
          if (busy) pausedUntil = Math.max(pausedUntil, Date.now() + wait);
          else await sleep(wait);
        }
      }
    }
  }));

  const documents: AnalyzedDocument[] = [];
  const fileIndexes: number[] = [];
  const unreadable: SkippedFile[] = [];
  results.forEach((result, slot) => {
    const i = toRead[slot];
    if (result instanceof Error) {
      unreadable.push({
        fileName: files[i].name,
        fileIndex: firstIndex + i,
        retryable: true,
        reason: REFUSAL_REASONS[readerRefusal(result) ?? 'unreadable'],
      });
    } else {
      documents.push({ ...result, fileHash: hashes[i], sourceIndex: firstIndex + i, sizeBytes: files[i].size });
      fileIndexes.push(firstIndex + i);
    }
  });
  return { documents, fileIndexes, unreadable, duplicates };
}

const REFUSAL_REASONS = {
  'daily-limit': "The document reader has used up today's allowance. It resets tomorrow; raising the Gemini limit (billing) fixes it for good.",
  'rate-limit': 'The document reader hit its per-minute limit. Wait a minute, then try again.',
  overloaded: "Google's document reader is overloaded right now. Try again in a moment.",
  unreadable: 'We could not read this file. Try again, or upload a clearer copy.',
} as const;

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
      // The reason goes to the log in full; the warning carries only FactorCloud's status code, which
      // is enough to tell an expired sign-in (401), a missing record (404) or a refusal apart.
      console.error(`[paperwork] FactorCloud client lookup failed for ${clientId}`, err);
      const code = err instanceof FactorCloudError ? err.status : null;
      warnings.push(code === 401
        ? 'FactorCloud connection is unavailable. Contact your factor and try again.'
        : `FactorCloud is temporarily unavailable${code ? ` (FactorCloud error ${code} reading the client record)` : ''}. The document checks below still hold, but check again before sending.`);
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
