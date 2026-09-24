export type DocumentType = 'invoice' | 'bol' | 'pod' | 'rate_confirmation' | 'other';

export interface ExtractedFields {
  documentType: DocumentType;
  invoiceNumber: string | null;
  referenceNumber: string | null;
  documentDate: string | null;
  clientName: string | null;
  debtorName: string | null;
  debtorAddress: string | null;
  debtorCity: string | null;
  debtorState: string | null;
  debtorZip: string | null;
  debtorPhone: string | null;
  debtorEmail: string | null;
  debtorEin: string | null;
  invoiceAmount: number | null;
  invoiceDate: string | null;
  dueDate: string | null;
  signaturePresent: boolean | null;
  uncertainFields: string[];
  notes: string | null;
}

export interface AnalyzedDocument {
  fileName: string;
  fields: ExtractedFields;
}

export interface CompanyRecord {
  id: string;
  compCode?: string | null;
  companyName?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  stateCode?: string | null;
  zipCode?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  email?: string[] | string | null;
  ein?: string | null;
  companyType?: string | null;
  noBuy?: boolean | null;
}

export type CheckStatus = 'PASS' | 'REVIEW' | 'FAIL' | 'SKIP';
export type OverallStatus = 'PASS' | 'REVIEW' | 'FAIL';

export interface Comparison {
  label: string;
  document: string;
  other: string;
}

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  comparisons?: Comparison[];
}

export interface ValidationReport {
  status: OverallStatus;
  checks: CheckResult[];
}

export interface AnalyzeResponse {
  documents: AnalyzedDocument[];
  primaryIndex: number;
  debtor: CompanyRecord | null;
  debtorMatch: { method: string; score: number } | null;
  client: CompanyRecord | null;
  validation: ValidationReport;
  warnings: string[];
}

export interface CreateStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface CreateResponse {
  ok: boolean;
  invoiceId: string | null;
  documentIds: string[];
  steps: CreateStep[];
  validation?: ValidationReport;
  error?: string;
}
