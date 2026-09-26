// In-memory state for demo mode: the generated portfolio plus anything created during the demo
// (new invoices, review decisions). Lives for the life of the server process only.

import { buildDemoPortfolio, buildDemoReviews, type DemoInvoice, type DemoPortfolio, type DemoReview, type DemoSubmission } from './demo-data';
import { DEMO_CLIENT_ID, DEMO_FACTOR_ID } from './demo';
import { portalConfig } from './portal-config';
import type { PortalSession } from './session';
import type { PortalSubmissionDetail } from './submission-detail';
import type { CompanyRecord, ValidationReport } from './types';

interface DemoState {
  day: string;
  portfolio: DemoPortfolio;
  created: DemoInvoice[];
  reviews: DemoReview[];
  submissions: DemoSubmission[];
  documentSeq: number;
  tasks?: DemoTask[];
}

export interface DemoTask {
  id: string;
  reviewId: string;
  submissionId: string;
  invoiceId: string;
  clientId: string;
  invoiceNumber: string;
  message: string;
  status: 'OPEN' | 'DONE' | 'CANCELED';
  createdAt: string;
  resolvedAt: string | null;
  responseNote: string | null;
  files: { fileName: string; sizeBytes: number }[];
}

const globalState = globalThis as unknown as { __fcDemoState?: DemoState };

function state(): DemoState {
  const day = new Date().toISOString().slice(0, 10);
  // Built once per server process, so a demo running past midnight UTC keeps its new invoices and
  // decisions; restart the server to slide the dates forward.
  if (!globalState.__fcDemoState) {
    const portfolio = buildDemoPortfolio(day, portalConfig.clientName);
    globalState.__fcDemoState = { day, portfolio, created: [], reviews: buildDemoReviews(portfolio, Date.now()), submissions: [], documentSeq: 0 };
  }
  return globalState.__fcDemoState;
}

export const DEMO_SESSION: PortalSession = {
  v: 1,
  userId: 'demo-user',
  email: 'demo@factorcloud.example',
  displayName: 'Demo Admin',
  role: 'FACTOR_ADMIN',
  factorId: DEMO_FACTOR_ID,
  clients: [{ id: 'demo-portal-client', factorCloudClientId: DEMO_CLIENT_ID, name: portalConfig.clientName }],
  exp: Number.MAX_SAFE_INTEGER,
};

export function demoInvoices(): DemoInvoice[] {
  const s = state();
  return [...s.portfolio.invoices, ...s.created];
}

export function demoInvoice(id: string): DemoInvoice | null {
  return demoInvoices().find((invoice) => invoice.id === id) ?? null;
}

export function demoCompany(id: string): CompanyRecord | null {
  const { portfolio } = state();
  return portfolio.clients.find((c) => c.id === id) ?? portfolio.debtors.find((d) => d.id === id) ?? null;
}

export function demoDebtors(): CompanyRecord[] {
  return state().portfolio.debtors;
}

/** The debtor the canned extraction reads off every demo document. */
export function demoHeadlineDebtor(): CompanyRecord {
  return state().portfolio.debtors[0];
}

export function demoToday(): string {
  return state().day;
}

export function addDemoInvoice(input: { invoiceNumber: string; referenceNumber: string | null; companyClientId: string; companyDebtorId: string; invoiceAmount: number; invoiceDate: string; notes: string | null }): DemoInvoice {
  const s = state();
  const client = demoCompany(input.companyClientId);
  const debtor = demoCompany(input.companyDebtorId);
  const now = new Date();
  const invoice: DemoInvoice = {
    id: `demo-new-${String(s.created.length + 1).padStart(3, '0')}`,
    invoiceNumber: input.invoiceNumber,
    referenceNumber: input.referenceNumber ?? '',
    companyClientId: input.companyClientId,
    companyClientName: client?.companyName ?? input.companyClientId,
    companyDebtorId: input.companyDebtorId,
    companyDebtorName: debtor?.companyName ?? input.companyDebtorId,
    invoiceAmount: input.invoiceAmount,
    invoiceBalance: input.invoiceAmount,
    advanceAmount: 0,
    escrowReserveAmount: 0,
    purchaseFeeAmount: 0,
    invoiceDate: `${input.invoiceDate}T00:00:00Z`,
    createdOn: now.toISOString(),
    fundedDate: null,
    paidDate: null,
    dueDate: new Date(Date.parse(`${input.invoiceDate}T00:00:00Z`) + 30 * 86_400_000).toISOString(),
    status: 'PENDING',
    verificationStatus: 'NOT_VERIFIED',
    paymentStatus: 'OPEN',
    disputed: false,
    notes: input.notes,
  };
  s.created.push(invoice);
  return invoice;
}

export function nextDemoDocumentId(): string {
  const s = state();
  s.documentSeq += 1;
  return `demo-doc-${String(s.documentSeq).padStart(4, '0')}`;
}

export function recordDemoSubmission(input: { invoiceId: string; clientId: string; debtorId: string; validation: ValidationReport; files: { fileName: string; documentType: string; sizeBytes: number }[] }): void {
  const s = state();
  const submission: DemoSubmission = {
    submissionId: `demo-sub-new-${s.submissions.length + 1}`,
    createdAt: new Date().toISOString(),
    workflowStatus: input.validation.status === 'REVIEW' ? 'REVIEW_REQUIRED' : 'CREATED_IN_FACTORCLOUD',
    ...input,
  };
  s.submissions.push(submission);
  if (input.validation.status === 'REVIEW') {
    const invoice = demoInvoice(input.invoiceId);
    if (invoice) {
      s.reviews.unshift({
        reviewId: `demo-review-new-${s.submissions.length}`,
        submissionId: submission.submissionId,
        invoiceId: invoice.id,
        clientId: invoice.companyClientId,
        clientName: invoice.companyClientName,
        debtorId: invoice.companyDebtorId,
        invoiceNumber: invoice.invoiceNumber,
        referenceNumber: invoice.referenceNumber,
        invoiceAmount: invoice.invoiceAmount,
        invoiceDate: invoice.invoiceDate.slice(0, 10),
        reason: input.validation.checks.filter((c) => c.status === 'REVIEW').map((c) => c.label).join(', ') || 'Portal review required.',
        checks: input.validation.checks.filter((c) => c.status === 'REVIEW' || c.status === 'FAIL'),
        createdAt: submission.createdAt,
        status: 'OPEN',
        decisionNote: null,
        decidedAt: null,
      });
    }
  }
}

export function demoReviews(): DemoReview[] {
  return state().reviews;
}

function demoTaskList(): DemoTask[] {
  const s = state();
  s.tasks ??= [];
  return s.tasks;
}

/** A reviewer asks the client for a fix; the review stays open. */
export function demoRequestFix(reviewId: string, message: string): DemoTask | null {
  const review = state().reviews.find((r) => r.reviewId === reviewId && r.status === 'OPEN');
  if (!review) return null;
  const tasks = demoTaskList();
  for (const task of tasks) if (task.submissionId === review.submissionId && task.status === 'OPEN') { task.status = 'CANCELED'; task.resolvedAt = new Date().toISOString(); }
  const task: DemoTask = {
    id: `demo-task-${tasks.length + 1}`,
    reviewId,
    submissionId: review.submissionId,
    invoiceId: review.invoiceId,
    clientId: review.clientId,
    invoiceNumber: review.invoiceNumber,
    message,
    status: 'OPEN',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    responseNote: null,
    files: [],
  };
  tasks.push(task);
  return task;
}

export function demoClientTasks(clientId: string, status: DemoTask['status'] = 'OPEN'): DemoTask[] {
  return demoTaskList().filter((task) => task.clientId === clientId && task.status === status).reverse();
}

export function demoLatestTask(submissionId: string): DemoTask | null {
  return demoTaskList().filter((task) => task.submissionId === submissionId && task.status !== 'CANCELED').at(-1) ?? null;
}

export function demoSubmitFix(taskId: string, clientId: string, files: { fileName: string; sizeBytes: number }[], note: string | null): DemoTask | null {
  const task = demoTaskList().find((t) => t.id === taskId && t.clientId === clientId && t.status === 'OPEN');
  if (!task) return null;
  task.status = 'DONE';
  task.resolvedAt = new Date().toISOString();
  task.responseNote = note;
  task.files = files;
  return task;
}

export function decideDemoReview(reviewId: string, decision: 'APPROVE' | 'REJECT', note: string | null): DemoReview | null {
  const review = state().reviews.find((r) => r.reviewId === reviewId && r.status === 'OPEN');
  if (!review) return null;
  for (const task of demoTaskList()) if (task.submissionId === review.submissionId && task.status === 'OPEN') { task.status = 'CANCELED'; task.resolvedAt = new Date().toISOString(); }
  review.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  review.decisionNote = note;
  review.decidedAt = new Date().toISOString();
  const invoice = demoInvoice(review.invoiceId);
  if (invoice && decision === 'APPROVE' && invoice.status === 'PENDING') {
    invoice.status = 'APPROVED';
    invoice.verificationStatus = 'VERIFIED';
  }
  return review;
}

/** Portal workflow detail for an invoice, in the same shape the database version returns. */
export function demoSubmissionDetail(by: { invoiceId?: string; submissionId?: string }): PortalSubmissionDetail | null {
  const s = state();
  const submission = s.submissions.find((x) => x.invoiceId === by.invoiceId || x.submissionId === by.submissionId);
  const review = s.reviews.find((r) => r.invoiceId === by.invoiceId || r.submissionId === by.submissionId);
  const invoiceId = submission?.invoiceId ?? review?.invoiceId ?? by.invoiceId;
  const invoice = invoiceId ? demoInvoice(invoiceId) : null;
  if (!invoice) return null;
  // Most portal-era invoices (the last 90 days) went through the portal; older ones did not.
  const ageDays = (Date.parse(`${s.day}T00:00:00Z`) - Date.parse(invoice.invoiceDate)) / 86_400_000;
  if (!submission && !review && ageDays > 90) return null;

  const createdAt = submission?.createdAt ?? review?.createdAt ?? invoice.createdOn;
  const validation: ValidationReport = submission?.validation ?? {
    status: review ? 'REVIEW' : 'PASS',
    checks: [
      ...(review?.checks ?? []),
      { id: 'invoice-in-packet', label: 'Invoice in packet', status: 'PASS', message: 'An invoice was identified in the uploaded packet.' },
      { id: 'required-fields', label: 'Required invoice fields', status: 'PASS', message: 'Invoice number, amount, date and debtor were all read.' },
      { id: 'debtor-found', label: 'Debtor found in FactorCloud', status: 'PASS', message: `Matched ${invoice.companyDebtorName} by exact name.` },
      { id: 'client', label: 'Client matches FactorCloud client', status: 'PASS', message: 'Invoice was issued by this client.' },
      { id: 'duplicate', label: 'Not a duplicate', status: 'PASS', message: 'No other invoice with this number exists for this client.' },
    ],
  };
  const at = (offsetSeconds: number) => new Date(Date.parse(createdAt) + offsetSeconds * 1000).toISOString();
  const actor = { email: 'dispatch@client.example', name: 'Client dispatcher' };
  const system = { email: null, name: null };
  const audit: PortalSubmissionDetail['audit'] = [
    { id: `${invoice.id}-a1`, eventType: 'SUBMISSION_RECEIVED', eventData: { validationStatus: validation.status, invoiceNumber: invoice.invoiceNumber, checks: validation.checks }, createdAt: at(0), actor },
    { id: `${invoice.id}-a2`, eventType: 'FACTORCLOUD_INVOICE_CREATED', eventData: { invoiceId: invoice.id }, createdAt: at(3), actor: system },
    { id: `${invoice.id}-a3`, eventType: 'DOCUMENTS_ATTACHED', eventData: { invoiceId: invoice.id }, createdAt: at(6), actor: system },
  ];
  if (review) audit.push({ id: `${invoice.id}-a4`, eventType: 'REVIEW_OPENED', eventData: { reason: review.reason }, createdAt: at(7), actor: system });
  const tasks = demoTaskList().filter((task) => task.submissionId === (submission?.submissionId ?? review?.submissionId));
  for (const task of tasks) {
    audit.push({ id: `${task.id}-req`, eventType: 'FIX_REQUESTED', eventData: { note: task.message }, createdAt: task.createdAt, actor: { email: DEMO_SESSION.email, name: DEMO_SESSION.displayName } });
    if (task.status === 'DONE') audit.push({ id: `${task.id}-done`, eventType: 'FIX_SUBMITTED', eventData: { note: task.responseNote, files: task.files.map((f) => f.fileName) }, createdAt: task.resolvedAt!, actor });
  }
  if (review?.decidedAt) audit.push({ id: `${invoice.id}-a5`, eventType: review.status === 'APPROVED' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED', eventData: { note: review.decisionNote }, createdAt: review.decidedAt, actor: { email: DEMO_SESSION.email, name: DEMO_SESSION.displayName } });
  audit.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const fixFiles = tasks.flatMap((task) => task.files.map((f) => ({ fileName: f.fileName, documentType: 'fix', sizeBytes: f.sizeBytes })));
  const baseFiles = submission?.files ?? [
    { fileName: `${invoice.invoiceNumber}.pdf`, documentType: 'invoice', sizeBytes: 184_220 },
    { fileName: `BOL-${invoice.referenceNumber}.pdf`, documentType: 'bol', sizeBytes: 402_918 },
    { fileName: `POD-${invoice.referenceNumber}.jpg`, documentType: 'pod', sizeBytes: 1_208_331 },
  ];
  const files = [...baseFiles, ...fixFiles];
  const fields = { invoiceNumber: invoice.invoiceNumber, referenceNumber: invoice.referenceNumber, invoiceAmount: invoice.invoiceAmount, invoiceDate: invoice.invoiceDate.slice(0, 10) };
  return {
    id: submission?.submissionId ?? review?.submissionId ?? `demo-sub-${invoice.id}`,
    factorCloudInvoiceId: invoice.id,
    factorCloudClientId: invoice.companyClientId,
    clientName: invoice.companyClientName,
    debtorFactorCloudId: invoice.companyDebtorId,
    validationStatus: validation.status,
    workflowStatus: review ? (review.status === 'OPEN' ? 'REVIEW_REQUIRED' : review.status) : submission?.workflowStatus ?? 'CREATED_IN_FACTORCLOUD',
    createdAt,
    updatedAt: review?.decidedAt ?? createdAt,
    submittedBy: actor,
    original: fields,
    submitted: fields,
    files: files.map((file, i) => ({ id: `${invoice.id}-f${i}`, fileName: file.fileName, sourceIndex: i, sha256: 'demo', documentType: file.documentType, fileSizeBytes: file.sizeBytes, createdAt })),
    reviews: review ? [{ id: review.reviewId, status: review.status, reason: review.reason, decisionNote: review.decisionNote, createdAt: review.createdAt, decidedAt: review.decidedAt, decidedBy: review.decidedAt ? { email: DEMO_SESSION.email, name: DEMO_SESSION.displayName } : { email: null, name: null } }] : [],
    audit,
  };
}
