import { NextResponse } from 'next/server';
import {
  FC_DOCUMENT_TYPES,
  allowedDebtorIds,
  attachDocuments,
  createInvoice,
  findExistingInvoice,
  getCompany,
  uploadDocument,
} from '@/lib/factorcloud';
import { isBlank, normalizeDate, normalizeMoney } from '@/lib/normalize';
import { apiErrorResponse, publicErrorMessage } from '@/lib/api-errors';
import { isDefinitiveCreateFailure } from '@/lib/errors';
import { adminDriverViewAllowed, currentPortalSession, resolveConfiguredClientId } from '@/lib/portal-auth';
import { validate } from '@/lib/rules';
import { applyCreditCheck, CREDIT_CHECK_ID, withoutCreditCheck } from '@/lib/credit';
import { loadDebtorCredit } from '@/lib/debtor-credit';
import { recordDemoSubmission } from '@/lib/demo-store';
import { persistSubmissionStart, markSubmissionFactorCloudResult, recordSubmissionAudit, type StoredSubmission } from '@/lib/submission-store';
import { hashFile, verifyAnalysisReceipt } from '@/lib/submission-integrity';
import type { CheckResult, CreateResponse, CreateStep, ValidationReport } from '@/lib/types';
import { demoClientView, demoRequest } from '@/lib/demo-request';
import { DEMO_DRIVER } from '@/lib/demo';
import { buildPortalNote } from '@/lib/portal-notes';
import { labelForReview } from '@/lib/review-label';
import { explanationProblem, flaggedChecks, forFactorReview, hardBlocks, needsExplanation, withClientExplanation } from '@/lib/override';

export const runtime = 'nodejs';
export const maxDuration = 120;

interface CreatePayload {
  invoiceNumber: string;
  referenceNumber: string | null;
  invoiceAmount: number | string;
  invoiceDate: string;
  debtorId: string;
  analysisReceipt: string;
  /** Why the client is submitting despite warnings or failed checks. Required unless every check passes. */
  explanation?: string | null;
}

export async function POST(req: Request) {
  let clientId: string;
  try { clientId = await resolveConfiguredClientId(); }
  catch (err) { return apiErrorResponse(err, 'create'); }

  const form = await req.formData();
  let payload: CreatePayload;
  try { payload = JSON.parse(String(form.get('payload'))); }
  catch { return NextResponse.json({ error: 'Missing payload.' }, { status: 400 }); }

  const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
  const allowedDebtors = await allowedDebtorIds();
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
  catch (err) { return apiErrorResponse(err, 'create'); }

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
  catch (err) { return NextResponse.json({ error: `Cannot re-check FactorCloud records: ${publicErrorMessage(err, 'create')}` }, { status: 502 }); }

  const originalPrimary = receipt.documents[receipt.primaryIndex].fields;
  const corrections = collectClientCorrections(originalPrimary, payload);
  const rawValidation = validate({ documents: receipt.documents, primaryIndex: receipt.primaryIndex, debtor, client });
  let validation = addCorrectionReview(rawValidation, corrections);
  const blocked = hardBlocks(validation);
  if (blocked.length) return NextResponse.json({ error: `This invoice cannot be submitted: ${blocked.map((check) => check.message).join(' ')}`, validation }, { status: 409 });
  if (needsExplanation(validation)) {
    const problem = explanationProblem(payload.explanation);
    if (problem) return NextResponse.json({ error: `Some checks did not pass. ${problem}`, validation, needsExplanation: true }, { status: 409 });
    validation = withClientExplanation(validation, payload.explanation!);
  }
  // The credit check runs last, with fresh balances and the amount actually being sent. It never
  // needs a note from the client and is never shown to them: if the invoice would go over the
  // limit, it goes to the factor's review queue with a warning for the approver.
  validation = applyCreditCheck(validation, await loadDebtorCredit(clientId, debtor, amount));

  let duplicateCheckComplete = true;
  try {
    const duplicateNumbers = [...new Set([originalPrimary.invoiceNumber?.trim(), payload.invoiceNumber.trim()].filter((value): value is string => Boolean(value)))];
    for (const invoiceNumber of duplicateNumbers) {
      const { existing, complete } = await findExistingInvoice(clientId, invoiceNumber);
      if (existing) return NextResponse.json({
        error: `Invoice ${invoiceNumber} has already been submitted.`,
        duplicate: { invoiceId: existing.id, invoiceNumber, status: existing.status ?? null },
        validation: withoutCreditCheck(validation),
      }, { status: 409 });
      duplicateCheckComplete &&= complete;
    }
  } catch (err) {
    return NextResponse.json({ error: `Duplicate check failed, so submission was blocked: ${publicErrorMessage(err, 'create')}`, validation: withoutCreditCheck(validation) }, { status: 502 });
  }
  // Could not read FactorCloud's invoice list to the end: submit, but flag for a person to confirm.
  if (!duplicateCheckComplete) validation = addDuplicateCheckReview(validation);
  validation = forFactorReview(validation);

  // Demo submissions stay in memory: nothing is written to the portal database.
  const demo = await demoRequest();
  const session = demo ? null : await currentPortalSession();
  let storedSubmission: StoredSubmission | null = null;
  if (!demo) try {
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
    return apiErrorResponse(err, 'create', 500, { validation: withoutCreditCheck(validation) });
  }

  const steps: CreateStep[] = [];
  const documentIds: string[] = [];
  let invoiceId: string | null = null;
  const respond = (ok: boolean, error?: string) => NextResponse.json({ ok, invoiceId, documentIds, steps, validation: withoutCreditCheck(validation), error } satisfies CreateResponse, { status: ok ? 200 : 502 });

  try {
    // With admin views the note says who sent the invoice: the Driver view lists what was sent
    // from it, and without the portal database the note is the only record of that.
    const sender = (await adminDriverViewAllowed()) ? ((await demoClientView()) === 'driver' ? 'Driver' as const : 'Office' as const) : null;
    // FactorCloud notes may be visible beyond the factor, so the credit warning stays out of them.
    const notes = buildPortalNote({
      review: validation.status === 'REVIEW',
      sender,
      flagged: flaggedChecks(validation.checks).filter((check) => check.id !== CREDIT_CHECK_ID).map((check) => check.label),
      corrections,
      clientNote: payload.explanation,
    });
    const created = await createInvoice({
      invoiceNumber: payload.invoiceNumber.trim(),
      referenceNumber: payload.referenceNumber?.trim() || null,
      companyClientId: clientId,
      companyDebtorId: payload.debtorId,
      invoiceAmount: amount!,
      invoiceDate: invoiceDate!,
      notes,
    });
    invoiceId = created.id;
    steps.push({ step: 'Create invoice', ok: true, detail: `Invoice ${invoiceId}` });
    await markSubmissionFactorCloudResult({ submission: storedSubmission, session, invoiceId, validationStatus: validation.status });
  } catch (err) {
    const detail = publicErrorMessage(err, 'create');
    // Only a definite FactorCloud refusal means no invoice exists, so only then may the client retry.
    const retryable = isDefinitiveCreateFailure(err);
    steps.push({ step: 'Create invoice', ok: false, detail });
    try { await markSubmissionFactorCloudResult({ submission: storedSubmission, session, validationStatus: validation.status, error: detail, retryable }); } catch { /* original error remains primary */ }
    return respond(false, retryable
      ? `FactorCloud did not accept the invoice, so nothing was created: ${detail} You can correct the problem and submit again.`
      : `The FactorCloud result is uncertain: ${detail} Do not resubmit. Your factor needs to check FactorCloud first.`);
  }

  for (const [i, file] of files.entries()) {
    const wanted = FC_DOCUMENT_TYPES[receipt.documents[i].fields.documentType] ?? 'INVOICE';
    try {
      const doc = await uploadDocument(clientId, file, wanted);
      documentIds.push(doc.id);
      const note = doc.type !== wanted ? ` (type ${wanted} rejected, uploaded as ${doc.type})` : ` as ${doc.type}`;
      steps.push({ step: `Upload ${file.name}`, ok: true, detail: `Document ${doc.id}${note}` });
    } catch (err) {
      const detail = publicErrorMessage(err, 'create');
      steps.push({ step: `Upload ${file.name}`, ok: false, detail });
      try { await recordSubmissionAudit({ submission: storedSubmission, session, eventType: 'DOCUMENT_UPLOAD_FAILED', eventData: { invoiceId, fileName: file.name, error: detail } }); } catch { /* original error remains primary */ }
      return respond(false, `Invoice ${invoiceId} was created, but uploading ${file.name} failed. Do not recreate it. Attach the missing file in FactorCloud and retry only after checking the existing invoice.`);
    }
  }

  if (documentIds.length) {
    try {
      await attachDocuments(invoiceId!, documentIds);
      steps.push({ step: 'Attach documents', ok: true, detail: `${documentIds.length} document(s) attached` });
      try { await recordSubmissionAudit({ submission: storedSubmission, session, eventType: 'DOCUMENTS_ATTACHED', eventData: { invoiceId, documentIds } }); } catch { /* invoice workflow should still succeed */ }
    } catch (err) {
      const detail = publicErrorMessage(err, 'create');
      steps.push({ step: 'Attach documents', ok: false, detail });
      try { await recordSubmissionAudit({ submission: storedSubmission, session, eventType: 'DOCUMENT_ATTACH_FAILED', eventData: { invoiceId, documentIds, error: detail } }); } catch { /* original error remains primary */ }
      return respond(false, `Invoice ${invoiceId} was created and documents uploaded, but attaching them failed. Do not recreate it. Attach the uploaded documents in FactorCloud.`);
    }
  }

  // Flagged invoices get the factor's review label so they stand out in FactorCloud's list. Best
  // effort and not shown to the sender: the invoice is created either way.
  if (validation.status === 'REVIEW' && !demo) {
    const labelled = await labelForReview(invoiceId!);
    try { await recordSubmissionAudit({ submission: storedSubmission, session, eventType: labelled.ok ? 'REVIEW_LABEL_ADDED' : 'REVIEW_LABEL_FAILED', eventData: { invoiceId, detail: labelled.detail } }); } catch { /* invoice workflow should still succeed */ }
  }

  if (demo) {
    recordDemoSubmission({
      submittedBy: (await demoClientView()) === 'driver' ? DEMO_DRIVER : 'Office',
      invoiceId: invoiceId!,
      clientId,
      debtorId: payload.debtorId,
      validation,
      files: files.map((file, i) => ({ fileName: file.name, documentType: receipt.documents[i].fields.documentType, sizeBytes: file.size })),
    });
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

function addDuplicateCheckReview(validation: ValidationReport): ValidationReport {
  const check: CheckResult = {
    id: 'duplicate-check-incomplete',
    label: 'Duplicate check',
    status: 'REVIEW',
    message: 'FactorCloud\'s invoice list could not be read completely, so a duplicate of this invoice number cannot be ruled out. Confirm in FactorCloud before approving.',
  };
  return { status: validation.status === 'FAIL' ? 'FAIL' : 'REVIEW', checks: [check, ...validation.checks] };
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

