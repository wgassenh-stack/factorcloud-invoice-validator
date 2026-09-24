// Shared types used by the API routes and the browser UI.

export type DocumentType = 'invoice' | 'bol' | 'pod' | 'rate_confirmation' | 'other';

/** Structured fields the AI extracts from one uploaded document. */
export interface ExtractedFields {
  documentType: DocumentType;
  invoiceNumber: string | null;
  referenceNumber: string | null;
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
  invoiceDate: string | null; // YYYY-MM-DD
  dueDate: string | null; // YYYY-MM-DD
  signaturePresent: boolean | null;
  uncertainFields: string[];
  notes: string | null;
}

export interface AnalyzedDocument {
  fileName: string;
  fields: ExtractedFields;
}

/** Subset of the FactorCloud company record (GET /companies/{id}) used for validation. */
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
  email?: string | null;
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

/** Response of POST /api/analyze. */
export interface AnalyzeResponse {
  documents: AnalyzedDocument[];
  primaryIndex: number;
  debtor: CompanyRecord | null;
  debtorMatch: { method: string; score: number } | null;
  client: CompanyRecord | null;
  warnings: string[];
}

export interface CreateStep {
  step: string;
  ok: boolean;
  detail: string;
}

/** Response of POST /api/create. */
export interface CreateResponse {
  ok: boolean;
  invoiceId: string | null;
  documentIds: string[];
  steps: CreateStep[];
  error?: string;
}
