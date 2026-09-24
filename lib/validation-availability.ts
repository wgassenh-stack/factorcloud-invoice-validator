import type { ValidationReport } from './types';

export function applyFactorCloudAvailability(report: ValidationReport, lookupFailed: boolean): ValidationReport {
  if (!lookupFailed) return report;

  const checks = report.checks.map((check) =>
    check.id === 'debtor-found'
      ? {
          ...check,
          status: 'REVIEW' as const,
          message: 'FactorCloud lookup is temporarily unavailable. Retry analysis before creating this invoice.',
        }
      : check,
  );

  const status = checks.some((check) => check.status === 'FAIL')
    ? 'FAIL'
    : checks.some((check) => check.status === 'REVIEW')
      ? 'REVIEW'
      : 'PASS';

  return { status, checks };
}
