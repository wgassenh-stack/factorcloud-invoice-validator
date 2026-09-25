// Error types shared by server routes. Kept free of server-only imports so they can be unit tested.

/** An error whose message was written for the end user and is safe to return in an API response. */
export class PublicError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = new.target.name;
  }
}

/** A FactorCloud API failure. `status` is FactorCloud's HTTP status (or ours for local failures). */
export class FactorCloudError extends Error {
  constructor(message: string, public status: number, public body: unknown) {
    super(message);
    this.name = 'FactorCloudError';
  }
}

/**
 * True when FactorCloud definitively refused to create the invoice, so no invoice exists and the
 * submission can safely be retried. A 4xx response is a refusal. Network errors, timeouts, 5xx
 * responses and "created but no id in the response" are uncertain: the invoice may exist.
 */
export function isDefinitiveCreateFailure(err: unknown): boolean {
  return err instanceof FactorCloudError && err.status >= 400 && err.status < 500;
}
