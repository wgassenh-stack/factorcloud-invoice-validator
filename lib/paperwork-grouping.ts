// Sorting a pile of uploaded paperwork into one group per invoice. Pure, so it can be tested.
//
// Each invoice starts a group. Every other document joins a group only when one signal points to
// exactly one invoice, tried in this order:
//   1. the same load / reference number
//   2. the same invoice number
//   3. a rate confirmation with the same customer and amount
//   4. photos taken as the same load (the camera's "Next load" button)
// Anything else is left for the person to place: guessing wrong would send the wrong POD with the
// wrong invoice. With a single invoice in the upload, everything goes with it (the checks then
// flag anything that doesn't match).

import { normalizeCompanyName, normalizeIdentifier, normalizeMoney } from './normalize';
import type { AnalyzedDocument } from './types';

export interface PaperworkGrouping {
  /** Each group lists document positions, invoice first. */
  groups: number[][];
  /** Documents that could not be placed confidently. */
  unassigned: number[];
}

/** `loads[i]` is the camera load a photo was taken in, or null for uploaded files. */
export function groupPaperwork(documents: AnalyzedDocument[], loads: (number | null)[] = []): PaperworkGrouping {
  const invoices = documents.flatMap((doc, i) => doc.fields.documentType === 'invoice' ? [i] : []);
  const supports = documents.flatMap((doc, i) => doc.fields.documentType === 'invoice' ? [] : [i]);
  if (!invoices.length) return { groups: [], unassigned: documents.map((_, i) => i) };
  if (invoices.length === 1) return { groups: [[invoices[0], ...supports]], unassigned: [] };

  const groups = invoices.map((i) => [i]);
  const unassigned: number[] = [];
  const only = (matches: number[]) => (matches.length === 1 ? matches[0] : null);

  for (const s of supports) {
    const support = documents[s].fields;
    const byReference = matching(invoices, (i) => sameId(documents[i].fields.referenceNumber, support.referenceNumber));
    const byInvoiceNumber = matching(invoices, (i) => sameId(documents[i].fields.invoiceNumber, support.invoiceNumber));
    const byRate = support.documentType === 'rate_confirmation'
      ? matching(invoices, (i) => sameCustomerAndAmount(documents[i], documents[s]))
      : [];
    const load = loads[s] ?? null;
    const byLoad = load == null ? [] : matching(invoices, (i) => (loads[i] ?? null) === load);

    // A reference number that points at two invoices is a real conflict: don't fall through to weaker signals.
    const pick = byReference.length > 1 ? null : only(byReference) ?? only(byInvoiceNumber) ?? only(byRate) ?? only(byLoad);
    if (pick == null) unassigned.push(s);
    else groups[invoices.indexOf(pick)].push(s);
  }
  return { groups, unassigned };
}

function matching(invoices: number[], test: (i: number) => boolean): number[] {
  return invoices.filter(test);
}

function sameId(a: string | null, b: string | null): boolean {
  const left = normalizeIdentifier(a);
  return Boolean(left) && left === normalizeIdentifier(b);
}

function sameCustomerAndAmount(invoice: AnalyzedDocument, rate: AnalyzedDocument): boolean {
  const customer = normalizeCompanyName(invoice.fields.debtorName);
  const invoiceAmount = normalizeMoney(invoice.fields.invoiceAmount);
  const rateAmount = normalizeMoney(rate.fields.invoiceAmount);
  return Boolean(customer) && customer === normalizeCompanyName(rate.fields.debtorName)
    && invoiceAmount !== null && rateAmount !== null && Math.abs(invoiceAmount - rateAmount) < 0.001;
}

/** Checks a grouping sent back by the browser: every position valid, none used twice, no empty group. */
export function groupingProblem(groups: number[][], documentCount: number): string | null {
  if (!Array.isArray(groups) || !groups.length) return 'Nothing to check.';
  if (groups.length > documentCount) return 'There are more groups than documents.';
  const seen = new Set<number>();
  for (const group of groups) {
    if (!Array.isArray(group) || !group.length) return 'Every group needs at least one document.';
    for (const i of group) {
      if (!Number.isInteger(i) || i < 0 || i >= documentCount) return 'A document in the grouping does not exist.';
      if (seen.has(i)) return 'A document is in more than one group.';
      seen.add(i);
    }
  }
  return null;
}

/**
 * Likely homes for documents that couldn't be placed, best first, as the invoice document of each
 * suggested group. Only a hint for the person placing it; nothing is moved automatically.
 */
export function suggestPlacements(documents: AnalyzedDocument[], groups: number[][], unassigned: number[], loads: (number | null)[] = []): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const d of unassigned) {
    const doc = documents[d].fields;
    const scored = groups.map((group) => {
      const invoice = documents[group[0]].fields;
      let score = 0;
      if (sameId(invoice.referenceNumber, doc.referenceNumber)) score += 3;
      else if (closeId(invoice.referenceNumber, doc.referenceNumber)) score += 2;
      if (sameId(invoice.invoiceNumber, doc.invoiceNumber)) score += 3;
      const load = loads[d] ?? null;
      if (load != null && group.some((i) => (loads[i] ?? null) === load)) score += 2;
      const customer = normalizeCompanyName(doc.debtorName);
      if (customer && customer === normalizeCompanyName(invoice.debtorName)) score += 1;
      // A POD or BOL most likely belongs to an invoice that doesn't have one yet.
      if (score === 0 && doc.documentType !== 'invoice' && !group.some((i) => documents[i].fields.documentType === doc.documentType)) score += 0.5;
      return { invoice: group[0], score };
    }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    // A weak "missing this type" hint only helps when it points at exactly one invoice.
    const strong = scored.filter((s) => s.score >= 1);
    out[d] = (strong.length ? strong : scored.length === 1 ? scored : []).slice(0, 3).map((s) => s.invoice);
  }
  return out;
}

/** Load numbers one typo apart (one character different, or one missing). */
function closeId(a: string | null, b: string | null): boolean {
  const x = normalizeIdentifier(a);
  const y = normalizeIdentifier(b);
  if (!x || !y || x === y || Math.abs(x.length - y.length) > 1 || Math.min(x.length, y.length) < 4) return false;
  if (x.length === y.length) return [...x].filter((ch, i) => ch !== y[i]).length === 1;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  for (let i = 0; i < long.length; i++) if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  return false;
}
