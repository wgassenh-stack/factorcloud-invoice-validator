import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { AnalyzedDocument } from './types';

export interface AnalysisReceiptPayload {
  version: 1;
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

export function signAnalysisReceipt(payload: AnalysisReceiptPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', signingSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyAnalysisReceipt(receipt: string): AnalysisReceiptPayload {
  const [encoded, suppliedSignature, extra] = receipt.split('.');
  if (!encoded || !suppliedSignature || extra) throw new Error('Analysis receipt is malformed.');

  const expectedSignature = createHmac('sha256', signingSecret()).update(encoded).digest('base64url');
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('Analysis receipt signature is invalid. Re-run verification.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Analysis receipt could not be read. Re-run verification.');
  }

  if (!isReceiptPayload(parsed)) throw new Error('Analysis receipt is incomplete. Re-run verification.');
  return parsed;
}

function signingSecret(): string {
  const secret = process.env.PORTAL_SIGNING_SECRET || process.env.APP_ACCESS_PASSWORD;
  if (!secret) throw new Error('PORTAL_SIGNING_SECRET is not configured.');
  return secret;
}

function isReceiptPayload(value: unknown): value is AnalysisReceiptPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as AnalysisReceiptPayload;
  return candidate.version === 1
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
