import { NextResponse } from 'next/server';
import {
  FC_DOCUMENT_TYPES,
  attachDocuments,
  createInvoice,
  uploadDocument,
} from '@/lib/factorcloud';
import { isBlank, normalizeDate, normalizeMoney } from '@/lib/normalize';
import type { CreateResponse, CreateStep } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface CreatePayload {
  invoiceNumber: string;
  referenceNumber: string | null;
  invoiceAmount: number | string;
  invoiceDate: string;
  notes: string | null;
  debtorId: string;
  /** Classified type per uploaded file, same order as `files`. */
  documentTypes: string[];
}

/**
 * Runs the sequence proven with Test003:
 *   POST /invoices -> POST /documents (per file) -> PUT /invoices/{id} { documents }
 * Stops at the first failure and reports what already happened, so a partially
 * created invoice is never silently re-created.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  let payload: CreatePayload;
  try {
    payload = JSON.parse(String(form.get('payload')));
  } catch {
    return NextResponse.json({ error: 'Missing payload.' }, { status: 400 });
  }
  const files = form.getAll('files').filter((f): f is File => f instanceof File);

  const clientId = process.env.FACTORCLOUD_CLIENT_ID;
  const allowedDebtors = (process.env.FACTORCLOUD_DEBTOR_IDS ?? '').split(',').map((s) => s.trim());
  const amount = normalizeMoney(payload.invoiceAmount);
  const invoiceDate = normalizeDate(payload.invoiceDate);
  const problems: string[] = [];
  if (!clientId) problems.push('FACTORCLOUD_CLIENT_ID is not configured');
  if (!payload.debtorId || !allowedDebtors.includes(payload.debtorId)) problems.push('debtor is not an allowed FactorCloud debtor');
  if (isBlank(payload.invoiceNumber)) problems.push('invoice # is required');
  if (amount === null || amount <= 0) problems.push('invoice amount must be positive');
  if (!invoiceDate) problems.push('invoice date is required');
  if (problems.length) return NextResponse.json({ error: `Cannot create invoice: ${problems.join('; ')}.` }, { status: 400 });

  const steps: CreateStep[] = [];
  const documentIds: string[] = [];
  let invoiceId: string | null = null;
  const respond = (ok: boolean, error?: string) =>
    NextResponse.json({ ok, invoiceId, documentIds, steps, error } satisfies CreateResponse, { status: ok ? 200 : 502 });

  try {
    const created = await createInvoice({
      invoiceNumber: payload.invoiceNumber.trim(),
      referenceNumber: payload.referenceNumber?.trim() || null,
      companyClientId: clientId!,
      companyDebtorId: payload.debtorId,
      invoiceAmount: amount!,
      invoiceDate,
      notes: payload.notes?.trim() || null,
    });
    invoiceId = created.id;
    steps.push({ step: 'Create invoice', ok: true, detail: `Invoice ${invoiceId}` });
  } catch (err) {
    steps.push({ step: 'Create invoice', ok: false, detail: message(err) });
    return respond(false, message(err));
  }

  for (const [i, file] of files.entries()) {
    const wanted = FC_DOCUMENT_TYPES[payload.documentTypes[i]] ?? 'INVOICE';
    try {
      const doc = await uploadDocument(clientId!, file, wanted);
      documentIds.push(doc.id);
      const note = doc.type !== wanted ? ` (type ${wanted} rejected, uploaded as ${doc.type})` : ` as ${doc.type}`;
      steps.push({ step: `Upload ${file.name}`, ok: true, detail: `Document ${doc.id}${note}` });
    } catch (err) {
      steps.push({ step: `Upload ${file.name}`, ok: false, detail: message(err) });
      return respond(false, `Invoice ${invoiceId} was created, but uploading ${file.name} failed. Attach it in FactorCloud; do not create the invoice again.`);
    }
  }

  if (documentIds.length) {
    try {
      await attachDocuments(invoiceId!, documentIds);
      steps.push({ step: 'Attach documents', ok: true, detail: `${documentIds.length} document(s) attached` });
    } catch (err) {
      steps.push({ step: 'Attach documents', ok: false, detail: message(err) });
      return respond(false, `Invoice ${invoiceId} was created and documents uploaded, but attaching them failed. Attach them in FactorCloud; do not create the invoice again.`);
    }
  }

  return respond(true);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
