// Validation rules engine. Pure and deterministic so it runs identically on the
// server and in the browser (the UI re-validates live as a reviewer edits fields).
//
// To change behaviour, edit RULES below. Each switch maps to one of the
// configurable rules Wallace described; turning one off shows the check as SKIP.

import type {
  AnalyzedDocument,
  CheckResult,
  CheckStatus,
  CompanyRecord,
  Comparison,
  DocumentType,
  ExtractedFields,
  OverallStatus,
  ValidationReport,
} from './types';
import {
  formatMoney,
  isBlank,
  normalizeCity,
  normalizeCompanyName,
  normalizeDate,
  normalizeIdentifier,
  normalizeMoney,
  normalizePhone,
  normalizeState,
  normalizeStreet,
  normalizeZip,
  similarity,
} from './normalize';

export interface RuleConfig {
  /** Debtor must exist in FactorCloud and not be flagged noBuy. */
  requireDebtorMatch: boolean;
  requireCompanyNameMatch: boolean;
  /** Accept near-identical names ("Acme Mfg LLC" vs "Acme Manufacturing LLC") above this score. */
  allowFuzzyCompanyName: boolean;
  fuzzyNameThreshold: number;
  requireAddressMatch: boolean;
  requirePhoneMatch: boolean;
  /** Client (seller) named on the invoice must match the FactorCloud client. */
  requireClientMatch: boolean;
  requireReferenceAcrossDocs: boolean;
  requireInvoiceNumberAcrossDocs: boolean;
  requireAmountAcrossDocs: boolean;
  /** Dollar difference still treated as a match. */
  amountTolerance: number;
  requireDatesAcrossDocs: boolean;
  /** 0 disables the age check. */
  maxInvoiceAgeDays: number;
  requireSignedPod: boolean;
  /** Fields the AI flagged as uncertain send the result to REVIEW. */
  reviewUncertainExtraction: boolean;
}

export const RULES: RuleConfig = {
  requireDebtorMatch: true,
  requireCompanyNameMatch: true,
  allowFuzzyCompanyName: true,
  fuzzyNameThreshold: 0.85,
  requireAddressMatch: true,
  requirePhoneMatch: true,
  requireClientMatch: true,
  requireReferenceAcrossDocs: true,
  requireInvoiceNumberAcrossDocs: true,
  requireAmountAcrossDocs: true,
  amountTolerance: 0,
  requireDatesAcrossDocs: true,
  maxInvoiceAgeDays: 60,
  requireSignedPod: false,
  reviewUncertainExtraction: true,
};

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  invoice: 'Invoice',
  bol: 'Bill of lading',
  pod: 'Proof of delivery',
  rate_confirmation: 'Rate confirmation',
  other: 'Other',
};

export interface ValidationInput {
  documents: AnalyzedDocument[];
  primaryIndex: number;
  debtor: CompanyRecord | null;
  client: CompanyRecord | null;
  /** YYYY-MM-DD; injectable for tests. */
  today?: string;
  rules?: RuleConfig;
}

export function validate(input: ValidationInput): ValidationReport {
  const rules = input.rules ?? RULES;
  const primary = input.documents[input.primaryIndex]?.fields;
  const checks: CheckResult[] = [];

  if (!primary) {
    return {
      status: 'FAIL',
      checks: [{ id: 'documents', label: 'Documents', status: 'FAIL', message: 'No document was analyzed.' }],
    };
  }

  checks.push(requiredFieldsCheck(primary));
  checks.push(debtorCheck(input.debtor, rules));
  checks.push(companyNameCheck(primary, input.debtor, rules));
  checks.push(addressCheck(primary, input.debtor, rules));
  checks.push(phoneCheck(primary, input.debtor, rules));
  checks.push(clientCheck(primary, input.client, rules));

  const docs = input.documents;
  checks.push(
    acrossDocs(docs, {
      id: 'reference-across-docs',
      label: 'Reference / load # matches across documents',
      enabled: rules.requireReferenceAcrossDocs,
      read: (f) => f.referenceNumber,
      normalize: normalizeIdentifier,
    }),
  );
  checks.push(
    acrossDocs(docs, {
      id: 'invoice-number-across-docs',
      label: 'Invoice # matches across documents',
      enabled: rules.requireInvoiceNumberAcrossDocs,
      read: (f) => f.invoiceNumber,
      normalize: normalizeIdentifier,
    }),
  );
  checks.push(amountAcrossDocs(docs, rules));
  checks.push(
    acrossDocs(docs, {
      id: 'date-across-docs',
      label: 'Invoice date matches across documents',
      enabled: rules.requireDatesAcrossDocs,
      read: (f) => f.invoiceDate,
      normalize: normalizeDate,
    }),
  );
  checks.push(
    acrossDocs(docs, {
      id: 'debtor-across-docs',
      label: 'Debtor name matches across documents',
      enabled: rules.requireCompanyNameMatch,
      read: (f) => f.debtorName,
      normalize: normalizeCompanyName,
      equal: (a, b) => a === b || (rules.allowFuzzyCompanyName && similarity(a, b) >= rules.fuzzyNameThreshold),
    }),
  );
  checks.push(invoiceAgeCheck(primary, rules, input.today ?? todayIso()));
  checks.push(signedPodCheck(docs, rules));
  checks.push(uncertaintyCheck(docs, rules));

  return { status: overallStatus(checks), checks };
}

export function overallStatus(checks: CheckResult[]): OverallStatus {
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  if (checks.some((c) => c.status === 'REVIEW')) return 'REVIEW';
  return 'PASS';
}

function check(
  id: string,
  label: string,
  status: CheckStatus,
  message: string,
  comparisons?: Comparison[],
): CheckResult {
  return comparisons ? { id, label, status, message, comparisons } : { id, label, status, message };
}

const show = (v: string | null | undefined) => (isBlank(v) ? '(blank)' : String(v));

function requiredFieldsCheck(f: ExtractedFields): CheckResult {
  const missing: string[] = [];
  if (isBlank(f.invoiceNumber)) missing.push('invoice #');
  if (f.invoiceAmount === null || f.invoiceAmount <= 0) missing.push('invoice amount');
  if (!normalizeDate(f.invoiceDate)) missing.push('invoice date');
  const label = 'Required invoice fields present';
  return missing.length
    ? check('required-fields', label, 'FAIL', `Missing or unreadable: ${missing.join(', ')}.`)
    : check('required-fields', label, 'PASS', 'Invoice #, amount and date are present.');
}

function debtorCheck(debtor: CompanyRecord | null, rules: RuleConfig): CheckResult {
  const label = 'Debtor found in FactorCloud';
  if (!rules.requireDebtorMatch) return check('debtor-found', label, 'SKIP', 'Rule disabled.');
  if (!debtor) return check('debtor-found', label, 'FAIL', 'No matching debtor was found in FactorCloud.');
  if (debtor.noBuy) {
    return check('debtor-found', label, 'FAIL', `${debtor.companyName} is flagged No Buy in FactorCloud.`);
  }
  return check('debtor-found', label, 'PASS', `${debtor.companyName}${debtor.compCode ? ` (${debtor.compCode})` : ''}`);
}

function companyNameCheck(f: ExtractedFields, debtor: CompanyRecord | null, rules: RuleConfig): CheckResult {
  const id = 'company-name';
  const label = 'Company name match';
  if (!rules.requireCompanyNameMatch) return check(id, label, 'SKIP', 'Rule disabled.');
  if (!debtor) return check(id, label, 'SKIP', 'No FactorCloud debtor to compare against.');
  const comparisons = [{ label: 'Debtor name', document: show(f.debtorName), other: show(debtor.companyName) }];
  if (isBlank(f.debtorName)) return check(id, label, 'REVIEW', 'Debtor name not found on the document.', comparisons);
  const a = normalizeCompanyName(f.debtorName);
  const b = normalizeCompanyName(debtor.companyName);
  if (a === b) return check(id, label, 'PASS', 'Names match.', comparisons);
  const score = similarity(a, b);
  if (rules.allowFuzzyCompanyName && score >= rules.fuzzyNameThreshold) {
    return check(id, label, 'PASS', `Close match (${Math.round(score * 100)}% similar).`, comparisons);
  }
  return check(id, label, 'REVIEW', 'Debtor name on the document differs from FactorCloud.', comparisons);
}

function addressCheck(f: ExtractedFields, debtor: CompanyRecord | null, rules: RuleConfig): CheckResult {
  const id = 'address';
  const label = 'Address match';
  if (!rules.requireAddressMatch) return check(id, label, 'SKIP', 'Rule disabled.');
  if (!debtor) return check(id, label, 'SKIP', 'No FactorCloud debtor to compare against.');

  const parts: { label: string; doc: string | null; fc: string | null | undefined; norm: (v: string | null | undefined) => string }[] = [
    { label: 'Street', doc: f.debtorAddress, fc: debtor.address1, norm: normalizeStreet },
    { label: 'City', doc: f.debtorCity, fc: debtor.city, norm: normalizeCity },
    { label: 'State', doc: f.debtorState, fc: debtor.stateCode, norm: normalizeState },
    { label: 'ZIP', doc: f.debtorZip, fc: debtor.zipCode, norm: normalizeZip },
  ];
  const comparisons = parts.map((p) => ({ label: p.label, document: show(p.doc), other: show(p.fc) }));
  const missing = parts.filter((p) => isBlank(p.doc)).map((p) => p.label.toLowerCase());
  const mismatched = parts
    .filter((p) => !isBlank(p.doc) && !isBlank(p.fc) && p.norm(p.doc) !== p.norm(p.fc))
    .map((p) => p.label.toLowerCase());
  const fcMissing = parts.filter((p) => !isBlank(p.doc) && isBlank(p.fc)).map((p) => p.label.toLowerCase());

  if (mismatched.length) return check(id, label, 'REVIEW', `Address mismatch: ${mismatched.join(', ')}.`, comparisons);
  if (missing.length === parts.length) return check(id, label, 'REVIEW', 'Debtor address not found on the document.', comparisons);
  if (missing.length) return check(id, label, 'REVIEW', `Not found on the document: ${missing.join(', ')}.`, comparisons);
  if (fcMissing.length) return check(id, label, 'REVIEW', `FactorCloud has no ${fcMissing.join(', ')} on file.`, comparisons);
  return check(id, label, 'PASS', 'Address matches FactorCloud.', comparisons);
}

function phoneCheck(f: ExtractedFields, debtor: CompanyRecord | null, rules: RuleConfig): CheckResult {
  const id = 'phone';
  const label = 'Phone match';
  if (!rules.requirePhoneMatch) return check(id, label, 'SKIP', 'Rule disabled.');
  if (!debtor) return check(id, label, 'SKIP', 'No FactorCloud debtor to compare against.');
  const comparisons = [{ label: 'Phone', document: show(f.debtorPhone), other: show(debtor.phone) }];
  if (isBlank(f.debtorPhone)) return check(id, label, 'REVIEW', 'Debtor phone not found on the document.', comparisons);
  if (isBlank(debtor.phone)) return check(id, label, 'REVIEW', 'FactorCloud has no phone on file.', comparisons);
  return normalizePhone(f.debtorPhone) === normalizePhone(debtor.phone)
    ? check(id, label, 'PASS', 'Phone matches FactorCloud.', comparisons)
    : check(id, label, 'REVIEW', 'Phone mismatch.', comparisons);
}

function clientCheck(f: ExtractedFields, client: CompanyRecord | null, rules: RuleConfig): CheckResult {
  const id = 'client';
  const label = 'Client matches FactorCloud client';
  if (!rules.requireClientMatch) return check(id, label, 'SKIP', 'Rule disabled.');
  if (!client) return check(id, label, 'SKIP', 'FactorCloud client record not loaded.');
  const comparisons = [{ label: 'Client', document: show(f.clientName), other: show(client.companyName) }];
  if (isBlank(f.clientName)) return check(id, label, 'REVIEW', 'Client (seller) name not found on the document.', comparisons);
  const a = normalizeCompanyName(f.clientName);
  const b = normalizeCompanyName(client.companyName);
  if (a === b || (rules.allowFuzzyCompanyName && similarity(a, b) >= rules.fuzzyNameThreshold)) {
    return check(id, label, 'PASS', 'Client matches.', comparisons);
  }
  return check(id, label, 'REVIEW', 'Invoice was issued by a different company than the FactorCloud client.', comparisons);
}

interface AcrossDocsSpec {
  id: string;
  label: string;
  enabled: boolean;
  read: (f: ExtractedFields) => string | null;
  normalize: (v: string | null | undefined) => string;
  equal?: (a: string, b: string) => boolean;
}

function docLabel(d: AnalyzedDocument): string {
  return `${DOCUMENT_TYPE_LABELS[d.fields.documentType]} (${d.fileName})`;
}

function acrossDocs(docs: AnalyzedDocument[], spec: AcrossDocsSpec): CheckResult {
  if (!spec.enabled) return check(spec.id, spec.label, 'SKIP', 'Rule disabled.');
  const present = docs.filter((d) => !isBlank(spec.read(d.fields)));
  if (docs.length < 2) return check(spec.id, spec.label, 'SKIP', 'Only one document uploaded.');
  if (present.length < 2) return check(spec.id, spec.label, 'SKIP', 'Value appears on fewer than two documents.');

  const equal = spec.equal ?? ((a: string, b: string) => a === b);
  const base = spec.normalize(spec.read(present[0].fields));
  const comparisons = present.map((d) => ({ label: docLabel(d), document: show(spec.read(d.fields)), other: '' }));
  const allMatch = present.every((d) => equal(base, spec.normalize(spec.read(d.fields))));
  return allMatch
    ? check(spec.id, spec.label, 'PASS', `Consistent across ${present.length} documents.`, comparisons)
    : check(spec.id, spec.label, 'REVIEW', 'Documents disagree.', comparisons);
}

function amountAcrossDocs(docs: AnalyzedDocument[], rules: RuleConfig): CheckResult {
  const id = 'amount-across-docs';
  const label = 'Amount matches across documents';
  if (!rules.requireAmountAcrossDocs) return check(id, label, 'SKIP', 'Rule disabled.');
  if (docs.length < 2) return check(id, label, 'SKIP', 'Only one document uploaded.');
  const present = docs.filter((d) => d.fields.invoiceAmount !== null);
  if (present.length < 2) return check(id, label, 'SKIP', 'Amount appears on fewer than two documents.');
  const amounts = present.map((d) => normalizeMoney(d.fields.invoiceAmount) ?? 0);
  const spread = Math.max(...amounts) - Math.min(...amounts);
  const comparisons = present.map((d) => ({
    label: docLabel(d),
    document: formatMoney(d.fields.invoiceAmount),
    other: '',
  }));
  return spread <= rules.amountTolerance + 0.001
    ? check(id, label, 'PASS', `Consistent across ${present.length} documents.`, comparisons)
    : check(id, label, 'REVIEW', `Amounts differ by ${formatMoney(spread)}.`, comparisons);
}

function invoiceAgeCheck(f: ExtractedFields, rules: RuleConfig, today: string): CheckResult {
  const id = 'invoice-age';
  const label = 'Invoice age';
  if (!rules.maxInvoiceAgeDays) return check(id, label, 'SKIP', 'Rule disabled.');
  const date = normalizeDate(f.invoiceDate);
  if (!date) return check(id, label, 'SKIP', 'No invoice date.');
  const days = Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
  if (days < -1) return check(id, label, 'REVIEW', `Invoice is dated ${-days} days in the future.`);
  if (days > rules.maxInvoiceAgeDays) {
    return check(id, label, 'REVIEW', `Invoice is ${days} days old (limit ${rules.maxInvoiceAgeDays}).`);
  }
  return check(id, label, 'PASS', `${Math.max(days, 0)} days old.`);
}

function signedPodCheck(docs: AnalyzedDocument[], rules: RuleConfig): CheckResult {
  const id = 'signed-pod';
  const label = 'Signed proof of delivery';
  if (!rules.requireSignedPod) return check(id, label, 'SKIP', 'Rule disabled.');
  const pods = docs.filter((d) => d.fields.documentType === 'pod' || d.fields.documentType === 'bol');
  if (!pods.length) return check(id, label, 'FAIL', 'No POD or BOL was uploaded.');
  return pods.some((d) => d.fields.signaturePresent)
    ? check(id, label, 'PASS', 'A signed POD/BOL is attached.')
    : check(id, label, 'REVIEW', 'No signature detected on the POD/BOL.');
}

function uncertaintyCheck(docs: AnalyzedDocument[], rules: RuleConfig): CheckResult {
  const id = 'extraction-confidence';
  const label = 'Extraction confidence';
  if (!rules.reviewUncertainExtraction) return check(id, label, 'SKIP', 'Rule disabled.');
  const flagged = docs.filter((d) => d.fields.uncertainFields.length > 0);
  if (!flagged.length) return check(id, label, 'PASS', 'All fields were read clearly.');
  const comparisons = flagged.map((d) => ({
    label: docLabel(d),
    document: d.fields.uncertainFields.join(', '),
    other: d.fields.notes ?? '',
  }));
  return check(id, label, 'REVIEW', 'Some fields were hard to read. Check them against the document.', comparisons);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
