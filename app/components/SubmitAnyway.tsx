'use client';

import { MIN_EXPLANATION_LENGTH, MAX_EXPLANATION_LENGTH, explanationProblem } from '@/lib/override';
import type { CheckResult } from '@/lib/types';

/**
 * Shown when a packet did not pass every check. The client can still submit it, but has to say why;
 * the note goes to the factor's review queue with the flagged checks.
 */
export function SubmitAnywayBox({ flagged, blocked, value, onChange, compact = false }: {
  flagged: CheckResult[];
  blocked: CheckResult[];
  value: string;
  onChange: (next: string) => void;
  compact?: boolean;
}) {
  if (blocked.length) {
    return <div className="submitAnyway blocked">
      <strong>This invoice can't be submitted</strong>
      {blocked.map((check) => <span key={check.id}>{check.message}</span>)}
      <small>Contact your factor about this debtor.</small>
    </div>;
  }
  if (!flagged.length) return null;
  const length = value.trim().length;
  const ok = !explanationProblem(value);
  return <div className={`submitAnyway ${compact ? 'compact' : ''}`}>
    <strong>Submit anyway?</strong>
    <span>{flagged.length === 1 ? 'This check did not pass' : `These ${flagged.length} checks did not pass`}. You can still send it in: your factor will review it before funding and will see your note.</span>
    {!compact && <ul>{flagged.map((check) => <li key={check.id} className={check.status.toLowerCase()}><b>{check.label}:</b> {check.message}</li>)}</ul>}
    <label>
      <span>Why are you submitting it anyway?</span>
      <textarea
        rows={compact ? 2 : 3}
        maxLength={MAX_EXPLANATION_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. The invoice date is one day off from the BOL. The load delivered on the 14th, so the invoice is correct."
      />
    </label>
    <small className={ok ? 'ok' : ''}>{ok ? '✓ Your note will go to the factor with this invoice.' : `${Math.max(0, MIN_EXPLANATION_LENGTH - length)} more character${MIN_EXPLANATION_LENGTH - length === 1 ? '' : 's'} needed.`}</small>
  </div>;
}
