import type { RiskInvoiceRecord } from './risk';

export interface OpsClientSummary {
  clientId: string;
  clientName: string;
  invoiceCount: number;
  invoiceAmount: number;
  latestInvoiceDate: string | null;
  statuses: Record<string, number>;
}

export function summarizeClients(records: RiskInvoiceRecord[], clientNames: Record<string, string>): OpsClientSummary[] {
  const grouped = new Map<string, OpsClientSummary>();

  for (const record of records) {
    if (!record.companyClientId) continue;
    const current = grouped.get(record.companyClientId) ?? {
      clientId: record.companyClientId,
      clientName: clientNames[record.companyClientId] || record.companyClientId,
      invoiceCount: 0,
      invoiceAmount: 0,
      latestInvoiceDate: null,
      statuses: {},
    };

    current.invoiceCount += 1;
    current.invoiceAmount += record.invoiceAmount ?? 0;
    if (record.invoiceDate && (!current.latestInvoiceDate || record.invoiceDate > current.latestInvoiceDate)) current.latestInvoiceDate = record.invoiceDate;
    const status = record.status || 'UNKNOWN';
    current.statuses[status] = (current.statuses[status] ?? 0) + 1;
    grouped.set(record.companyClientId, current);
  }

  return [...grouped.values()].sort((a, b) => {
    const byDate = String(b.latestInvoiceDate ?? '').localeCompare(String(a.latestInvoiceDate ?? ''));
    return byDate || b.invoiceAmount - a.invoiceAmount;
  });
}
