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
import { currentPortalSession, PortalAccessError, resolveConfiguredClientId } from '@/lib/portal-auth';
import { validate } from '@/lib/rules';
import { persistSubmissionStart, markSubmissionFactorCloudResult, type StoredSubmission } from '@/lib/submission-store';
import { hashFile, verifyAnalysisReceipt } from '@/lib/submission-integrity';
import type { CheckResult, CreateResponse, CreateStep, ValidationReport } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface CreatePayload {
  invoiceNumber: string;
  referenceNumber: string | null;
  invoiceAmount: number | string;
  invoiceDate: string;
  debtorId: string;
  analysisReceipt: string;
}

export async function POST(req: Request) {
  let clientId: string;
  try { clientId = await resolveConfiguredClientId(); }
  catch (err) {
    const status = err instanceof PortalAccessError ? err.status : 500;
    return NextResponse.json({ error: message(err) }, { status });
  }

  const form = await req.formData();
  let payload: CreatePayload;
  try { payload = JSON.parse(String(form.get('payload'))); }
  catch { return NextResponse.json({ error: 'Missing payload.' }, { status: 400 }); }

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  const allowedDebtors = (process.env.FACTORCLOUD_DEBTOR_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const amount = normalizeMoney(payload.invoiceAmount);
  const invoiceDate = normalizeDate(payload.invoiceDate);
  const problems: string[] = [];
  if (!payload.debtorId || !allowedDebtors.includes(payload.debtorId)) problems.push('debtor is not an allowed FactorCloud debtor');
  if (isBlank(payload.invoiceNumber)) problems.push('invoice # is required');
  if (amount === null || amount <= 0) problems.push('invoice amount must be positive');
  if (!invoiceDate) problems.push('invoice date is required');
  if (!payload.analysisReceipt) problems.push('signed verification receipt is required');
  if (!files.length) problems.push('at least one source document is required');
  if (problems.length) return NextResponse.json({ error: `Cannot create invoice: ${problems.join('; ')}.` }, { status: 400 });

  let receipt;
  try { receipt = verifyAnalysisReceipt(payload.analysisReceipt); }
  catch (err) { return NextResponse.json({ error: `Cannot create invoice: ${message(err)}` }, { status: 400 }); }

  if (receipt.clientId !== clientId) problems.push('verification receipt belongs to a different client');
  if (receipt.debtorId !== payload.debtorId) problems.push('debtor does not match the verified packet');
  if (receipt.primaryIndex < 0 || receipt.primaryIndex >= receipt.documents.length) problems.push('verified primary invoice selection is invalid');
  if (files.length !== receipt.documents.length) problems.push('uploaded files do not match the verified document set');

  if (!problems.length) {
    const actualHashes = await Promise.all(files.map((file) => hashFile(file)));
    for (let i = 0; i < receipt.documents.length; i++) {
      if (receipt.documents[i].fileHash !== actualHashes[i]) problems.push(`uploaded file ${i + 1} is not the same file that was verified`);
    }
  }
  if (problems.length) return NextResponse.json({ error: `Cannot create invoice: ${problems.join('; ')}.` }, { status: 400 });

  let debtor;
  let client;
  try { [debtor, client] = await Promise.all([getCompany(payload.debtorId), getCompany(clientId)]); }
  catch (err) { return NextResponse.json({ error: `Cannot re-check FactorCloud records: ${message(err)}` }, { status: 502 }); }

  const originalPrimary = receipt.documents[receipt.primaryIndex].fields;
  const corrections = collectClientCorrections(originalPrimary, payload);
  const rawValidation = validate({ documents: receipt.documents, primaryIndex: receipt.primaryIndex, debtor, client });
  const validation = addCorrectionReview(rawValidation, corrections);
  if (validation.status === 'FAIL') return NextResponse.json({ error: 'Validation failed. Fix the failed checks before submitting the invoice.', validation }, { status: 409 });

  try {
    const duplicateNumbers = [...new Set([originalPrimary.invoiceNumber?.trim(), payload.invoiceNumber.trim()].filter((value): value is string => Boolean(value)))];
    for (const invoiceNumber of duplicateNumbers) {
      const existing = await findExistingInvoice(clientId, payload.debtorId, invoiceNumber);
      if (existing) return NextResponse.json({ error: `Invoice ${invoiceNumber} already exists in FactorCloud as ${existing.id}${existing.status ? ` (${existing.status})` : ''}.`, validation }, { status: 409 });
    }
  } catch (err) {
    return NextResponse.json({ error: `Duplicate check failed, so submission was blocked: ${message(err)}`, validation }, { status: 502 });
  }

  const session = await currentPortalSession();
  let storedSubmission: StoredSubmission | null = null;
  try {
    storedSubmission = await persistSubmissionStart({
      session,
      factorCloudClientId: clientId,
      receipt,
      validation,
      invoiceNumber: payload.invoiceNumber.trim(),
      referenceNumber: payload.referenceNumber?.trim() || null,
      invoiceAmount: amount!,
      invoiceDate: invoiceDate!,
      analysisReceipt: payload.analysisReceipt,
      files,
    });
  } catch (err) {
    return NextResponse.json({ error: `Portal workflow blocked submission: ${message(err)}`, validation }, { status: 409 });
  }

  const steps: CreateStep[] = [];
  const documentIds: string[] = [];
  let invoiceId: string | null = null;
  const respond = (ok: boolean, error?: string) => NextResponse.json({ ok, invoiceId, documentIds, steps, validation, error } satisfies CreateResponse, { status: ok ? 200 : 502 });

  try {
    const noteParts = [
      'Submitted through FactorCloud client portal',
      validation.status === 'REVIEW' ? 'PORTAL REVIEW REQUIRED' : null,
      corrections.length ? `Client corrected after verification: ${corrections.join(', ')}` : null,
    ].filter(Boolean);
    const created = await createInvoice({
      invoiceNumber: payload.invoiceNumber.trim(),
      referenceNumber: payload.referenceNumber?.trim() || null,
      companyClientId: clientId,
      companyDebtorId: payload.debtorId,
      invoiceAmount: amount!,
      invoiceDate: invoiceDate!,
      notes: noteParts.join(' | '),
    });
    invoiceId = created.id;
    steps.push({ step: 'Create invoice', ok: true, detail: `Invoice ${invoiceId}` });
    await markSubmissionFactorCloudResult({ submission: storedSubmission, session, invoiceId, validationStatus: validation.status });
  } catch (err) {
    const detail = message(err);
    steps.push({ step: 'Create invoice', ok: false, detail });
    try { await markSubmissionFactorCloudResult({ submission: storedSubmission, session, validationStatus: validation.status, error: detail }); } catch { /* original error remains primary */ }
    return respond(false, detail);
  }

  for (const [i, file] of files.entries()) {
    const wanted = FC_DOCUMENT_TYPES[receipt.documents[i].fields.documentType] ?? 'INVOICE';
    try {
      const doc = await uploadDocument(clientId, file, wanted);
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

function collectClientCorrections(original: { invoiceNumber: string | null; referenceNumber: string | null; invoiceAmount: number | null; invoiceDate: string | null }, payload: CreatePayload): string[] {
  const corrections: string[] = [];
  if ((original.invoiceNumber ?? '').trim() !== (payload.invoiceNumber ?? '').trim()) corrections.push('invoice number');
  if ((original.referenceNumber ?? '').trim() !== (payload.referenceNumber ?? '').trim()) corrections.push('reference/load number');
  if (normalizeMoney(original.invoiceAmount) !== normalizeMoney(payload.invoiceAmount)) corrections.push('invoice amount');
  if (normalizeDate(original.invoiceDate) !== normalizeDate(payload.invoiceDate)) corrections.push('invoice date');
  return corrections;
}

function addCorrectionReview(validation: ValidationReport, corrections: string[]): ValidationReport {
  if (!corrections.length) return validation;
  const correctionCheck: CheckResult = {
    id: 'client-corrections',
    label: 'Client corrections',
    status: 'REVIEW',
    message: `The client changed verified field${corrections.length === 1 ? '' : 's'} after document analysis: ${corrections.join(', ')}.`,
  };
  return { status: validation.status === 'FAIL' ? 'FAIL' : 'REVIEW', checks: [correctionCheck, ...validation.checks] };
}

function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }
