import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { PublicError } from './errors';
import type { AnalyzedDocument } from './types';

/** A verification receipt older than this must be re-verified before submission. */
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tolerated clock difference for receipts that appear to be issued slightly in the future. */
const RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** A receipt problem the user can fix by re-running verification. */
export class ReceiptError extends PublicError {
  constructor(message: string) {
    super(message, 400);
  }
}

export interface AnalysisReceiptPayload {
  version: 1;
  /** Epoch milliseconds when the receipt was signed. */
  issuedAt: number;
  clientId: string;
  debtorId: string | null;
  primaryIndex: number;
  documents: AnalyzedDocument[];
}

export async function hashFile(file: File): Promise<string> {
  const bytes = Buffer.from(await file.arrayBuffer());
  return createHash('sha256').update(bytes).digest('hex');
}

export async function addFileIntegrity(files: File[], documents: AnalyzedDocument[]): Promise<AnalyzedDocument[]> {
  const hashes = await Promise.all(files.map((file) => hashFile(file)));
  return documents.map((document, index) => ({
    ...document,
    fileHash: hashes[index],
    sourceIndex: index,
  }));
}

export function signAnalysisReceipt(payload: Omit<AnalysisReceiptPayload, 'issuedAt'>, now = Date.now()): string {
  const signed: AnalysisReceiptPayload = { ...payload, issuedAt: now };
  const encoded = Buffer.from(JSON.stringify(signed)).toString('base64url');
  const signature = createHmac('sha256', signingSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyAnalysisReceipt(receipt: string, now = Date.now()): AnalysisReceiptPayload {
  const [encoded, suppliedSignature, extra] = receipt.split('.');
  if (!encoded || !suppliedSignature || extra) throw new ReceiptError('Analysis receipt is malformed. Re-run verification.');

  const expectedSignature = createHmac('sha256', signingSecret()).update(encoded).digest('base64url');
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ReceiptError('Analysis receipt signature is invalid. Re-run verification.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new ReceiptError('Analysis receipt could not be read. Re-run verification.');
  }

  if (!isReceiptPayload(parsed)) throw new ReceiptError('Analysis receipt is incomplete or from an older version. Re-run verification.');
  if (parsed.issuedAt > now + RECEIPT_CLOCK_SKEW_MS || now - parsed.issuedAt > RECEIPT_MAX_AGE_MS) {
    throw new ReceiptError('This verification has expired. Re-run verification before submitting.');
  }
  return parsed;
}

/** Throws before any paid work is done if receipts cannot be signed. */
export function assertReceiptSigningConfigured(): void {
  signingSecret();
}

/**
 * Receipts are signed with a dedicated secret only. There is deliberately no fallback to any other
 * setting: a shared or reused value would let anyone who knows it forge a "verified" packet.
 */
function signingSecret(): string {
  const secret = process.env.PORTAL_SIGNING_SECRET;
  if (!secret) throw new Error('PORTAL_SIGNING_SECRET is not configured.');
  return secret;
}

function isReceiptPayload(value: unknown): value is AnalysisReceiptPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as AnalysisReceiptPayload;
  return candidate.version === 1
    && typeof candidate.issuedAt === 'number'
    && Number.isFinite(candidate.issuedAt)
    && typeof candidate.clientId === 'string'
    && (candidate.debtorId === null || typeof candidate.debtorId === 'string')
    && Number.isInteger(candidate.primaryIndex)
    && Array.isArray(candidate.documents)
    && candidate.documents.length > 0
    && candidate.documents.every((document) =>
      document
      && typeof document.fileName === 'string'
      && typeof document.fileHash === 'string'
      && typeof document.sourceIndex === 'number'
      && document.fields
      && typeof document.fields === 'object');
}
