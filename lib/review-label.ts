import 'server-only';

import { listInvoiceLabels, setInvoiceLabels, type InvoiceLabel } from './factorcloud';

// Flagged invoices get a label in FactorCloud, so they stand out in its invoice list. The factor
// creates the label in FactorCloud; the portal finds it by name (FACTORCLOUD_REVIEW_LABEL, default
// "Portal review") or takes its ID from FACTORCLOUD_REVIEW_LABEL_ID.

const DEFAULT_NAME = 'Portal review';

/** Names match ignoring case, spacing and trailing punctuation ("Portal review." is "Portal review"). */
export function sameLabelName(a: string, b: string): boolean {
  const clean = (value: string) => value.toLowerCase().replace(/[\s.:!-]+$/g, '').replace(/\s+/g, ' ').trim();
  return clean(a) === clean(b);
}

export function reviewLabelName(): string {
  return process.env.FACTORCLOUD_REVIEW_LABEL?.trim() || DEFAULT_NAME;
}

export function findReviewLabel(labels: InvoiceLabel[], name = reviewLabelName()): InvoiceLabel | null {
  return labels.find((label) => sameLabelName(label.name, name)) ?? null;
}

let cached: { id: string | null; at: number } | null = null;
const CACHE_MS = 10 * 60_000;

async function reviewLabelId(): Promise<string | null> {
  const configured = process.env.FACTORCLOUD_REVIEW_LABEL_ID?.trim();
  if (configured) return configured;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.id;
  const id = findReviewLabel(await listInvoiceLabels())?.id ?? null;
  cached = { id, at: Date.now() };
  return id;
}

/**
 * Puts the review label on a newly created invoice. Returns what happened, for the create steps;
 * never throws, because the invoice itself is already created and fine without the label.
 */
export async function labelForReview(invoiceId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const id = await reviewLabelId();
    if (!id) return { ok: false, detail: `No "${reviewLabelName()}" label in FactorCloud, so none was added. Create it under Labels in FactorCloud.` };
    await setInvoiceLabels(invoiceId, [id]);
    return { ok: true, detail: `Labelled "${reviewLabelName()}" in FactorCloud.` };
  } catch (err) {
    cached = null;
    console.error('[review-label] could not label invoice', invoiceId, err);
    return { ok: false, detail: 'The review label could not be added in FactorCloud. The invoice and its note are fine.' };
  }
}
