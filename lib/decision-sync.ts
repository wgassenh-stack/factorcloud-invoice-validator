import 'server-only';

import { getInvoice, getInvoiceLabels, setInvoiceLabels, updateInvoiceNotes } from './factorcloud';
import { portalUpdateNote } from './portal-notes';
import { rejectedLabelId, rejectedLabelName, reviewLabelId, reviewLabelName } from './review-label';

// A decision in the portal's review queue is written back to the invoice in FactorCloud, so the
// factor sees it where they work: a line in the invoice's notes, and the review label taken off an
// approved invoice (or swapped for a "Portal rejected" label, when the factor has one). FactorCloud
// stays the system of record for status: approving or rejecting the invoice itself happens there.

export type PortalDecision = 'APPROVE' | 'REJECT' | 'REQUEST_FIX';

export function decisionLine(decision: PortalDecision, reviewer: string, note: string | null, at = new Date()): string {
  const day = at.toISOString().slice(0, 10);
  const what = decision === 'APPROVE' ? 'approved in the portal' : decision === 'REJECT' ? 'rejected in the portal' : 'fix requested from the client';
  return `${what} by ${reviewer} on ${day}${note?.trim() ? `: ${note.trim()}` : ''}`;
}

/** The label set after a decision, or null to leave the labels alone. */
export function labelsAfter(decision: PortalDecision, current: string[], review: string | null, rejected: string | null): string[] | null {
  if (decision === 'REQUEST_FIX' || !review) return null;
  const without = current.filter((id) => id !== review);
  const next = decision === 'REJECT' ? (rejected ? [...without.filter((id) => id !== rejected), rejected] : current) : without;
  const same = next.length === current.length && next.every((id, i) => id === current[i]);
  return same ? null : next;
}

function notesOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const invoice = (obj.invoice ?? obj.data ?? obj) as Record<string, unknown>;
  return typeof invoice?.notes === 'string' ? invoice.notes : null;
}

/** Never throws: the portal decision is already saved, and FactorCloud catching up is a bonus. */
export async function syncDecisionToFactorCloud(args: { invoiceId: string; decision: PortalDecision; reviewer: string; note: string | null }): Promise<{ ok: boolean; detail: string }> {
  const problems: string[] = [];
  try {
    const current = notesOf(await getInvoice(args.invoiceId));
    await updateInvoiceNotes(args.invoiceId, portalUpdateNote(current, decisionLine(args.decision, args.reviewer, args.note)));
  } catch (err) {
    console.error('[decision-sync] notes', args.invoiceId, err);
    problems.push('its notes could not be updated');
  }

  if (args.decision !== 'REQUEST_FIX') try {
    const review = await reviewLabelId();
    const rejected = args.decision === 'REJECT' ? await rejectedLabelId() : null;
    const current = (await getInvoiceLabels(args.invoiceId)).map((label) => label.id);
    const next = labelsAfter(args.decision, current, review, rejected);
    if (next) {
      await setInvoiceLabels(args.invoiceId, next);
      // FactorCloud's label call isn't documented: check it did what we asked.
      const after = (await getInvoiceLabels(args.invoiceId)).map((label) => label.id);
      const wrong = next.some((id) => !after.includes(id)) || (review && !next.includes(review) && after.includes(review));
      if (wrong) problems.push(`its labels could not be changed (the "${reviewLabelName()}" label may still be on it)`);
    }
  } catch (err) {
    console.error('[decision-sync] labels', args.invoiceId, err);
    problems.push('its labels could not be changed');
  }

  if (problems.length) return { ok: false, detail: `Saved in the portal, but in FactorCloud ${problems.join(' and ')}.` };
  const labelNote = args.decision === 'APPROVE' ? ` and the "${reviewLabelName()}" label removed` : args.decision === 'REJECT' ? ` (a "${rejectedLabelName()}" label is added if you create one)` : '';
  return { ok: true, detail: `FactorCloud notes updated${labelNote}.` };
}
