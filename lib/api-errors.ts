import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { FactorCloudError, PublicError } from './errors';

export interface PublicErrorBody {
  error: string;
  status: number;
  /** Set when the real error was withheld; the same reference is in the server log. */
  reference?: string;
}

/**
 * Decide what an API caller may see for an error. Messages written for users (PublicError) and
 * FactorCloud API responses pass through. Anything else (database, configuration, programming
 * errors) is withheld and replaced with a reference the operator can find in the server log.
 */
export function toPublicError(err: unknown, fallbackStatus = 500): PublicErrorBody {
  if (err instanceof PublicError) return { error: err.message, status: err.status };
  if (err instanceof FactorCloudError) return { error: err.message, status: fallbackStatus };
  const reference = randomUUID().slice(0, 8);
  return { error: `Something went wrong on our side. Reference ${reference}.`, status: fallbackStatus, reference };
}

/** JSON error response for a route. Logs the full error server-side whenever it is withheld. */
export function apiErrorResponse(err: unknown, context: string, fallbackStatus = 500, extra: Record<string, unknown> = {}) {
  const body = toPublicError(err, fallbackStatus);
  if (body.reference) console.error(`[${context}] reference=${body.reference}`, err);
  return NextResponse.json({ ...extra, error: body.error }, { status: body.status });
}

/** The user-safe message for an error, for embedding in a larger response. Logs when withheld. */
export function publicErrorMessage(err: unknown, context: string): string {
  const body = toPublicError(err);
  if (body.reference) console.error(`[${context}] reference=${body.reference}`, err);
  return body.error;
}
