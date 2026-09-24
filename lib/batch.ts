import type { AnalyzedDocument } from './types';
import { normalizeCompanyName, normalizeIdentifier, normalizeMoney } from './normalize';

export interface GroupedInvoicePacket {
  packetId: string;
  documents: AnalyzedDocument[];
  primaryIndex: number;
}

export interface BatchGroupingResult {
  packets: GroupedInvoicePacket[];
  unassignedDocuments: AnalyzedDocument[];
}

export function groupIntoInvoicePackets(documents: AnalyzedDocument[]): BatchGroupingResult {
  const invoiceDocs = documents.filter((d) => d.fields.documentType === 'invoice');
  if (!invoiceDocs.length) return { packets: [], unassignedDocuments: documents.slice() };

  const packets: GroupedInvoicePacket[] = invoiceDocs.map((invoice, index) => ({
    packetId: packetId(invoice, index),
    documents: [invoice],
    primaryIndex: 0,
  }));

  const supports = documents.filter((d) => d.fields.documentType !== 'invoice');
  const unassignedDocuments: AnalyzedDocument[] = [];

  for (const support of supports) {
    const referenceMatches = candidateIndexesByReference(support, invoiceDocs);
    if (referenceMatches.length === 1) {
      packets[referenceMatches[0]].documents.push(support);
      continue;
    }

    const secondaryMatches = candidateIndexesBySecondarySignals(support, invoiceDocs);
    if (referenceMatches.length === 0 && secondaryMatches.length === 1) {
      packets[secondaryMatches[0]].documents.push(support);
      continue;
    }

    unassignedDocuments.push(support);
  }

  return { packets, unassignedDocuments };
}

function candidateIndexesByReference(support: AnalyzedDocument, invoices: AnalyzedDocument[]): number[] {
  const reference = normalizeIdentifier(support.fields.referenceNumber);
  if (!reference) return [];
  return invoices.flatMap((invoice, index) =>
    normalizeIdentifier(invoice.fields.referenceNumber) === reference ? [index] : [],
  );
}

function candidateIndexesBySecondarySignals(support: AnalyzedDocument, invoices: AnalyzedDocument[]): number[] {
  const supportDebtor = normalizeCompanyName(support.fields.debtorName);
  const supportAmount = normalizeMoney(support.fields.invoiceAmount);

  return invoices.flatMap((invoice, index) => {
    const invoiceDebtor = normalizeCompanyName(invoice.fields.debtorName);
    const invoiceAmount = normalizeMoney(invoice.fields.invoiceAmount);
    const debtorMatches = Boolean(supportDebtor && invoiceDebtor && supportDebtor === invoiceDebtor);
    const amountMatches = supportAmount !== null && invoiceAmount !== null && Math.abs(supportAmount - invoiceAmount) < 0.001;

    if (support.fields.documentType === 'rate_confirmation' && debtorMatches && amountMatches) return [index];
    return [];
  });
}

function packetId(invoice: AnalyzedDocument, index: number): string {
  return normalizeIdentifier(invoice.fields.invoiceNumber) || `packet-${index + 1}`;
}
