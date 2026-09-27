import 'server-only';

import { FactorCloudError, allowedDebtorIds, getCompany } from './factorcloud';
import { scoreDebtor } from './matching';
import { validate } from './rules';
import { applyFactorCloudAvailability } from './validation-availability';
import { signAnalysisReceipt } from './submission-integrity';
import type { AnalyzeResponse, AnalyzedDocument, CompanyRecord } from './types';

// Checks each group of an upload as its own invoice: match the debtor, run the checks, and sign a
// receipt the create step verifies. Used when the paperwork is first read
// and again whenever someone moves a document to a different group (no re-reading needed).

/** One group of documents, checked as one invoice. Same shape the invoice create step expects. */
export interface PaperworkCard extends AnalyzeResponse {
  id: string;
  /** Positions of this card's documents in the upload, in the order the files must be sent. */
  documentIndexes: number[];
}

export interface PaperworkResponse {
  documents: AnalyzedDocument[];
  /** Signed copy of everything read, sent back for re-checks. */
  documentsReceipt: string;
  cards: PaperworkCard[];
  unassigned: number[];
  warnings: string[];
}

export async function checkCards(clientId: string, documents: AnalyzedDocument[], groups: { id: string; documentIndexes: number[] }[]): Promise<{ cards: PaperworkCard[]; warnings: string[] }> {
  const warnings: string[] = [];
  let client: CompanyRecord | null = null;
  let candidates: CompanyRecord[] = [];
  let lookupFailed = false;
  if (groups.length) {
    try {
      const ids = await allowedDebtorIds();
      const settled = await Promise.allSettled(ids.map((id) => getCompany(id)));
      candidates = settled.flatMap((r) => r.status === 'fulfilled' ? [r.value] : []);
      client = await getCompany(clientId);
    } catch (err) {
      lookupFailed = true;
      warnings.push(err instanceof FactorCloudError && err.status === 401
        ? 'FactorCloud connection is unavailable. Contact your factor and try again.'
        : 'FactorCloud is temporarily unavailable. The document checks below still hold, but check again before sending.');
    }
  }

  const cards = await Promise.all(groups.map(async (group) => {
    // Invoice first: it is the document the invoice is created from.
    const ordered = orderInvoiceFirst(group.documentIndexes, documents);
    const docs = ordered.map((i) => documents[i]);
    const primaryIndex = 0;
    const match = lookupFailed ? null : matchDebtor(docs, candidates);
    const debtor = match?.debtor ?? null;
    // No credit check here: credit limits are the factor's business. It runs when the invoice is
    // sent, and only the approver sees the result.
    const validation = applyFactorCloudAvailability(validate({ documents: docs, primaryIndex, debtor, client }), lookupFailed);
    const cardWarnings = docs[primaryIndex].fields.documentType === 'invoice' ? [] : ['No invoice in this group. Add the invoice, or move these documents to the group they belong to.'];
    const card: PaperworkCard = {
      id: group.id,
      documentIndexes: ordered,
      documents: docs,
      primaryIndex,
      debtor,
      debtorMatch: match ? { method: match.method, score: match.score } : null,
      client,
      factorCloudLookupFailed: lookupFailed,
      validation,
      warnings: cardWarnings,
      credit: null,
      analysisReceipt: signAnalysisReceipt({ version: 1, clientId, debtorId: debtor?.id ?? null, primaryIndex, documents: docs }),
    };
    return card;
  }));
  return { cards, warnings };
}

function orderInvoiceFirst(indexes: number[], documents: AnalyzedDocument[]): number[] {
  const invoice = indexes.find((i) => documents[i].fields.documentType === 'invoice');
  return invoice == null ? indexes.slice() : [invoice, ...indexes.filter((i) => i !== invoice)];
}

function matchDebtor(documents: AnalyzedDocument[], candidates: CompanyRecord[]) {
  let best: { debtor: CompanyRecord; method: string; score: number } | null = null;
  for (const document of documents) {
    for (const debtor of candidates) {
      const scored = scoreDebtor({ name: document.fields.debtorName, ein: document.fields.debtorEin, phone: document.fields.debtorPhone }, debtor);
      if (scored && (!best || scored.score > best.score)) best = { debtor, ...scored };
    }
  }
  return best;
}
