export interface RiskInvoiceRecord {
  id: string;
  invoiceNumber: string | null;
  companyClientId: string | null;
  companyDebtorId: string | null;
  invoiceAmount: number | null;
  invoiceDate: string | null;
  status: string | null;
  notes?: string | null;
  // Optional detail FactorCloud's list and single-invoice responses include. Used by the richer
  // dashboards; null when FactorCloud does not send the field.
  referenceNumber?: string | null;
  companyClientName?: string | null;
  companyDebtorName?: string | null;
  invoiceBalance?: number | null;
  advanceAmount?: number | null;
  escrowReserveAmount?: number | null;
  purchaseFeeAmount?: number | null;
  verificationStatus?: string | null;
  paymentStatus?: string | null;
  fundedDate?: string | null;
  paidDate?: string | null;
  dueDate?: string | null;
  createdOn?: string | null;
  disputed?: boolean | null;
}

export interface DebtorConcentration {
  debtorId: string;
  debtorName: string;
  amount: number;
  invoiceCount: number;
  share: number;
  level: 'NORMAL' | 'REVIEW' | 'HIGH';
}

export interface RiskAlert {
  id: string;
  level: 'INFO' | 'REVIEW' | 'HIGH';
  title: string;
  detail: string;
}

export interface RiskSummary {
  totalAmount: number;
  invoiceCount: number;
  last7Amount: number;
  prior28Amount: number;
  volumeRatio: number | null;
  concentrations: DebtorConcentration[];
  alerts: RiskAlert[];
}

export interface RiskThresholds {
  concentrationReview: number;
  concentrationHigh: number;
  volumeSpikeRatio: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  concentrationReview: 0.3,
  concentrationHigh: 0.5,
  volumeSpikeRatio: 1.5,
};

export function collectRiskInvoiceRecords(body: unknown): RiskInvoiceRecord[] {
  const out: RiskInvoiceRecord[] = [];
  const seen = new Set<unknown>();

  const walk = (cur: unknown) => {
    if (!cur || typeof cur !== 'object' || seen.has(cur)) return;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) walk(item);
      return;
    }

    const obj = cur as Record<string, unknown>;
    if (typeof obj.id === 'string' && typeof obj.invoiceNumber === 'string') {
      out.push({
        id: obj.id,
        invoiceNumber: asString(obj.invoiceNumber),
        companyClientId: asString(obj.companyClientId),
        companyDebtorId: asString(obj.companyDebtorId),
        invoiceAmount: asNumber(obj.invoiceAmount),
        invoiceDate: dateOnly(obj.invoiceDate),
        status: asString(obj.status),
        notes: asString(obj.notes),
        referenceNumber: asString(obj.referenceNumber),
        companyClientName: asString(obj.companyClientName),
        companyDebtorName: asString(obj.companyDebtorName),
        invoiceBalance: asNumber(obj.invoiceBalance),
        advanceAmount: asNumber(obj.advanceAmount),
        escrowReserveAmount: asNumber(obj.escrowReserveAmount),
        purchaseFeeAmount: asNumber(obj.purchaseFeeAmount),
        verificationStatus: asString(obj.verificationStatus),
        paymentStatus: asString(obj.paymentStatus),
        fundedDate: dateOnly(obj.fundedDate),
        paidDate: dateOnly(obj.paidDate),
        dueDate: dateOnly(obj.dueDate),
        createdOn: dateOnly(obj.createdOn),
        disputed: typeof obj.disputed === 'boolean' ? obj.disputed : null,
      });
    }
    for (const value of Object.values(obj)) walk(value);
  };

  walk(body);
  return [...new Map(out.map((record) => [record.id, record])).values()];
}

export function summarizeRisk(
  records: RiskInvoiceRecord[],
  debtorNames: Record<string, string>,
  today: string,
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
): RiskSummary {
  const dated = records.filter((record) => record.invoiceAmount !== null && record.invoiceAmount >= 0);
  const totalAmount = sum(dated.map((record) => record.invoiceAmount ?? 0));
  const invoiceCount = dated.length;
  const todayMs = startOfDay(today);
  const sevenDaysAgo = todayMs - 6 * DAY_MS;
  const thirtyFiveDaysAgo = todayMs - 34 * DAY_MS;
  const eightDaysAgo = todayMs - 7 * DAY_MS;

  const last7 = dated.filter((record) => {
    const ts = record.invoiceDate ? startOfDay(record.invoiceDate) : NaN;
    return Number.isFinite(ts) && ts >= sevenDaysAgo && ts <= todayMs;
  });
  const prior28 = dated.filter((record) => {
    const ts = record.invoiceDate ? startOfDay(record.invoiceDate) : NaN;
    return Number.isFinite(ts) && ts >= thirtyFiveDaysAgo && ts <= eightDaysAgo;
  });

  const last7Amount = sum(last7.map((record) => record.invoiceAmount ?? 0));
  const prior28Amount = sum(prior28.map((record) => record.invoiceAmount ?? 0));
  const prior7Equivalent = prior28Amount / 4;
  const volumeRatio = prior7Equivalent > 0 ? last7Amount / prior7Equivalent : null;

  const byDebtor = new Map<string, { amount: number; invoiceCount: number }>();
  for (const record of dated) {
    if (!record.companyDebtorId) continue;
    const current = byDebtor.get(record.companyDebtorId) ?? { amount: 0, invoiceCount: 0 };
    current.amount += record.invoiceAmount ?? 0;
    current.invoiceCount += 1;
    byDebtor.set(record.companyDebtorId, current);
  }

  const concentrations = [...byDebtor.entries()]
    .map(([debtorId, value]) => {
      const share = totalAmount > 0 ? value.amount / totalAmount : 0;
      return {
        debtorId,
        debtorName: debtorNames[debtorId] || debtorId,
        amount: value.amount,
        invoiceCount: value.invoiceCount,
        share,
        level: share >= thresholds.concentrationHigh ? 'HIGH' as const : share >= thresholds.concentrationReview ? 'REVIEW' as const : 'NORMAL' as const,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const alerts: RiskAlert[] = [];
  for (const concentration of concentrations) {
    if (concentration.level === 'NORMAL') continue;
    alerts.push({
      id: `concentration-${concentration.debtorId}`,
      level: concentration.level,
      title: `${concentration.debtorName} concentration`,
      detail: `${Math.round(concentration.share * 100)}% of invoice amount in the retrieved dataset is tied to this debtor.`,
    });
  }
  if (volumeRatio !== null && volumeRatio >= thresholds.volumeSpikeRatio) {
    alerts.push({
      id: 'volume-spike',
      level: volumeRatio >= thresholds.volumeSpikeRatio * 2 ? 'HIGH' : 'REVIEW',
      title: 'Recent volume spike',
      detail: `Last 7 days are ${volumeRatio.toFixed(1)}x the weekly pace of the prior 28 days.`,
    });
  }

  return { totalAmount, invoiceCount, last7Amount, prior28Amount, volumeRatio, concentrations, alerts };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function startOfDay(value: string): number {
  const ts = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : NaN;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

const DAY_MS = 24 * 60 * 60 * 1000;
