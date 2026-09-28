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
    clientNote: parts.find((part) => part.startsWith(CLIENT_NOTE))?.slice(CLIENT_NOTE.length) || null,
  };
}
