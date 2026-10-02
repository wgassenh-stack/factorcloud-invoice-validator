// A client's monthly statement, built from FactorCloud invoice records. It lists what happened in
// the month (invoices funded, invoices paid by debtors) and what that meant in cash for the client.
// FactorCloud reports balances as of today, not history, so the statement is activity-based rather
// than a running ledger; the open position shown is today's.

import { isClosedOut, isPaid, openBalance, reserveOn } from './analytics';
import type { RiskInvoiceRecord } from './risk';
import { csvCell } from './csv';

export interface StatementLine {
  date: string;
  kind: 'FUNDED' | 'PAID';
  invoiceId: string;
  invoiceNumber: string | null;
  debtorId: string | null;
  invoiceAmount: number;
  /** Cash to the client: the advance when funded; the reserve released (less fees) when paid. */
  toClient: number;
  fee: number;
}

export interface Statement {
  month: string;
  label: string;
  submitted: { count: number; amount: number };
  funded: { count: number; amount: number; advanced: number };
  paid: { count: number; amount: number; reserveReleased: number; fees: number };
  totalToClient: number;
  openToday: { count: number; balance: number };
  lines: StatementLine[];
}

export function statementMonths(today: string, count = 12): string[] {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
}

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
}

export function buildStatement(records: RiskInvoiceRecord[], month: string): Statement {
  const inMonth = (value: string | null | undefined) => Boolean(value && value.slice(0, 7) === month);
  const statement: Statement = {
    month,
    label: monthLabel(month),
    submitted: { count: 0, amount: 0 },
    funded: { count: 0, amount: 0, advanced: 0 },
    paid: { count: 0, amount: 0, reserveReleased: 0, fees: 0 },
    totalToClient: 0,
    openToday: { count: 0, balance: 0 },
    lines: [],
  };

  for (const record of records) {
    const amount = record.invoiceAmount ?? 0;
    if (inMonth(record.createdOn ?? record.invoiceDate) && !isClosedOut(record)) {
      statement.submitted.count += 1;
      statement.submitted.amount += amount;
    }
    if (inMonth(record.fundedDate)) {
      const advance = record.advanceAmount ?? 0;
      statement.funded.count += 1;
      statement.funded.amount += amount;
      statement.funded.advanced += advance;
      statement.lines.push({ date: record.fundedDate!.slice(0, 10), kind: 'FUNDED', invoiceId: record.id, invoiceNumber: record.invoiceNumber, debtorId: record.companyDebtorId, invoiceAmount: amount, toClient: advance, fee: 0 });
    }
    if (inMonth(record.paidDate)) {
      const fee = record.purchaseFeeAmount ?? 0;
      const released = reserveOn(record);
      statement.paid.count += 1;
      statement.paid.amount += amount;
      statement.paid.fees += fee;
      statement.paid.reserveReleased += released;
      statement.lines.push({ date: record.paidDate!.slice(0, 10), kind: 'PAID', invoiceId: record.id, invoiceNumber: record.invoiceNumber, debtorId: record.companyDebtorId, invoiceAmount: amount, toClient: released, fee });
    }
    if (!isPaid(record) && record.fundedDate) {
      const balance = openBalance(record);
      if (balance > 0) {
        statement.openToday.count += 1;
        statement.openToday.balance += balance;
      }
    }
  }

  statement.totalToClient = statement.funded.advanced + statement.paid.reserveReleased;
  statement.lines.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return statement;
}

/** CSV of the statement lines, with a totals row. Cells go through the shared CSV rule (no formulas). */
export function statementCsv(statement: Statement, debtorNames: Record<string, string>): string {
  const money = (value: number) => value.toFixed(2);
  const rows: (string | number)[][] = [
    ['Date', 'Event', 'Invoice', 'Debtor', 'Invoice amount', 'To you', 'Fee'],
    ...statement.lines.map((line) => [
      line.date,
      line.kind === 'FUNDED' ? 'Funded (advance)' : 'Paid by debtor (reserve released)',
      line.invoiceNumber ?? line.invoiceId,
      line.debtorId ? debtorNames[line.debtorId] ?? line.debtorId : '',
      money(line.invoiceAmount),
      money(line.toClient),
      money(line.fee),
    ]),
    ['', 'Total', '', '', '', money(statement.totalToClient), money(statement.paid.fees)],
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}
