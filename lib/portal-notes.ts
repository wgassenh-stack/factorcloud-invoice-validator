// The note the portal writes on every invoice it creates in FactorCloud, and how to read it back.
// Without the portal database (shared-password deployments) this note is the only record of an
// invoice having come through the portal, whether its checks flagged it, and who sent it in.

export const PORTAL_NOTE = 'Submitted through FactorCloud client portal';
export const REVIEW_NOTE = 'PORTAL REVIEW REQUIRED';
const CLIENT_NOTE = 'Client note: ';
const SENT_BY = 'Sent by: ';

export type PortalSender = 'Driver' | 'Office';

export function sentByNote(sender: PortalSender): string {
  return `${SENT_BY}${sender}`;
}

const FLAGGED = 'Flagged: ';
const CORRECTED = 'Client corrected after verification: ';

/**
 * The note for FactorCloud's Notes field. The client's own note comes last, so whatever they typed
 * (even a "|") reads back whole.
 */
export function buildPortalNote({ review, sender, flagged = [], corrections = [], clientNote }: {
  review: boolean;
  sender?: PortalSender | null;
  flagged?: string[];
  corrections?: string[];
  clientNote?: string | null;
}): string {
  return [
    PORTAL_NOTE,
    review ? REVIEW_NOTE : null,
    sender ? sentByNote(sender) : null,
    review && flagged.length ? `${FLAGGED}${flagged.join(', ')}` : null,
    corrections.length ? `${CORRECTED}${corrections.join(', ')}` : null,
    review && clientNote?.trim() ? `${CLIENT_NOTE}${clientNote.trim()}` : null,
  ].filter(Boolean).join(' | ');
}

export interface PortalNote {
  viaPortal: boolean;
  /** The portal's checks flagged it and the client sent it anyway. */
  flagged: boolean;
  sentBy: PortalSender | null;
  clientNote: string | null;
}

export function readPortalNote(notes: string | null | undefined): PortalNote {
  const parts = (notes ?? '').split(' | ').map((part) => part.trim());
  const sender = parts.find((part) => part.startsWith(SENT_BY))?.slice(SENT_BY.length);
  return {
    viaPortal: parts.includes(PORTAL_NOTE),
    flagged: parts.includes(REVIEW_NOTE),
    sentBy: sender === 'Driver' || sender === 'Office' ? sender : null,
    clientNote: clientNoteIn(notes ?? ''),
  };
}

function clientNoteIn(notes: string): string | null {
  const at = notes.indexOf(`| ${CLIENT_NOTE}`);
  const start = at >= 0 ? at + 2 : notes.startsWith(CLIENT_NOTE) ? 0 : -1;
  return start >= 0 ? notes.slice(start + CLIENT_NOTE.length).trim() || null : null;
}
