import { NextResponse } from 'next/server';
import {
  FC_DOCUMENT_TYPES,
  attachDocuments,
  createInvoice,
  findExistingInvoice,
  getCompany,
  uploadDocument,
} from '@/lib/factorcloud';
import { isBlank, normalizeDate, normalizeMoney } from '@/lib/normalize';
import { validate } from '@/lib/rules';
import type { AnalyzedDocument, CreateResponse, CreateStep } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface CreatePayload {
  invoiceNumber: string;
  referenceNumber: string | null;
  invoiceAmount: number | string;
  invoiceDate: string;
  notes: string | null;
  debtorId: string;
  primaryIndex: number;
  documents: AnalyzedDocument[];
  documentTypes: string[];
  overrideReview?: boolean;
  overrideReason?: string | null;
}

export async function POST(req: Request) {
  const form = await req.formData();
  let payload: CreatePayload;
  try { payload = JSON.parse(String(form.get('payload'))); }
  catch { return NextResponse.json({ error: 'Missing payload.' }, { status: 400 }); }

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  const clientId = process.env.FACTORCLOUD_CLIENT_ID;
  const allowedDebtors = (process.env.FACTORCLOUD_DEBTOR_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const amount = normalizeMoney(payload.invoiceAmount);
  const invoiceDate = normalizeDate(payload.invoiceDate);
  const problems: string[] = [];
  if (!clientId) problems.push('FACTORCLOUD_CLIENT_ID is not configured');
  if (!payload.debtorId || !allowedDebtors.includes(payload.debtorId)) problems.push('debtor is not an allowed FactorCloud debtor');
  if (isBlank(payload.invoiceNumber)) problems.push('invoice # is required');
  if (amount === null || amount <= 0) problems.push('invoice amount must be positive');
  if (!invoiceDate) problems.push('invoice date is required');
  if (!Array.isArray(payload.documents) || !payload.documents.length) problems.push('analyzed documents are required');
  if (!Number.isInteger(payload.primaryIndex) || payload.primaryIndex < 0 || payload.primaryIndex >= (payload.documents?.length ?? 0)) problems.push('primary invoice selection is invalid');
  if (!files.length) problems.push('at least one source document is required');
  if (files.length !== payload.documentTypes?.length) problems.push('document type list does not match uploaded files');
  if (problems.length) return NextResponse.json({ error: `Cannot create invoice: ${problems.join('; ')}.` }, { status: 400 });

  let debtor;
  let client;
  try {
    [debtor, client] = await Promise.all([getCompany(payload.debtorId), getCompany(clientId!)]);
  } catch (err) {
    return NextResponse.json({ error: `Cannot re-check FactorCloud records: ${message(err)}` }, { status: 502 });
  }

  const serverDocuments = payload.documents.map((d, i) => i === payload.primaryIndex ? {
    ...d,
    fields: {
      ...d.fields,
      invoiceNumber: payload.invoiceNumber.trim(),
      referenceNumber: payload.referenceNumber?.trim() || null,
      invoiceAmount: amount,
      invoiceDate,
    },
  } : d);
  const validation = validate({ documents: serverDocuments, primaryIndex: payload.primaryIndex, debtor, client });
  if (validation.status === 'FAIL') {
    return NextResponse.json({ error: 'Validation failed. Fix the failed checks before creating the invoice.', validation }, { status: 409 });
  }
  if (validation.status === 'REVIEW' && (!payload.overrideReview || !payload.overrideReason?.trim())) {
    return NextResponse.json({ error: 'This packet is in REVIEW. Confirm the override and enter a short reason before creating it.', validation }, { status: 409 });
  }

  try {
    const existing = await findExistingInvoice(clientId!, payload.debtorId, payload.invoiceNumber.trim());
    if (existing) {
      return NextResponse.json({ error: `Invoice ${payload.invoiceNumber.trim()} already exists in FactorCloud as ${existing.id}${existing.status ? ` (${existing.status})` : ''}.`, validation }, { status: 409 });
    }
  } catch (err) {
    return NextResponse.json({ error: `Duplicate check failed, so creation was blocked: ${message(err)}`, validation }, { status: 502 });
  }

  const steps: CreateStep[] = [];
  const documentIds: string[] = [];
  let invoiceId: string | null = null;
  const respond = (ok: boolean, error?: string) => NextResponse.json({ ok, invoiceId, documentIds, steps, validation, error } satisfies CreateResponse, { status: ok ? 200 : 502 });

  try {
    const noteParts = [payload.notes?.trim(), validation.status === 'REVIEW' ? `Validator override: ${payload.overrideReason?.trim()}` : null].filter(Boolean);
    const created = await createInvoice({
      invoiceNumber: payload.invoiceNumber.trim(),
      referenceNumber: payload.referenceNumber?.trim() || null,
      companyClientId: clientId!,
      companyDebtorId: payload.debtorId,
      invoiceAmount: amount!,
      invoiceDate,
      notes: noteParts.join(' | ') || null,
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
      return respond(false, `Invoice ${invoiceId} was created, but uploading ${file.name} failed. Do not recreate it. Attach the missing file in FactorCloud and retry only after checking the existing invoice.`);
    }
  }

  if (documentIds.length) {
    try {
      await attachDocuments(invoiceId!, documentIds);
      steps.push({ step: 'Attach documents', ok: true, detail: `${documentIds.length} document(s) attached` });
    } catch (err) {
      steps.push({ step: 'Attach documents', ok: false, detail: message(err) });
      return respond(false, `Invoice ${invoiceId} was created and documents uploaded, but attaching them failed. Do not recreate it. Attach the uploaded documents in FactorCloud.`);
    }
  }

  return respond(true);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
