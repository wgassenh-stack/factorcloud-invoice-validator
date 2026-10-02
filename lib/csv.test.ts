import { describe, expect, it } from 'vitest';
import { csvCell, csvRows } from './csv';
import { buildStatement, statementCsv } from './statements';

describe('CSV exports', () => {
  it('neutralizes text a spreadsheet would run as a formula', () => {
    for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=1', ' =1']) expect(csvCell(bad).replace(/^"|"$/g, '').startsWith("'")).toBe(true);
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });

  it('keeps numbers, negative ones included, and ordinary text as they are', () => {
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell('1000.00')).toBe('1000.00');
    expect(csvCell('INV-1001')).toBe('INV-1001');
    expect(csvCell('Acme, "Big" LLC')).toBe('"Acme, ""Big"" LLC"');
    expect(csvCell(null)).toBe('');
    expect(csvRows([['a', 1], ['b', 2]])).toBe('a,1\r\nb,2');
  });

  it('the statement export neutralizes a formula-looking invoice number', () => {
    const statement = buildStatement([{ id: 'i1', invoiceNumber: '=1+1', companyClientId: 'c', companyDebtorId: 'd1', invoiceAmount: 1000, invoiceDate: '2026-09-02', status: 'FUNDED', fundedDate: '2026-09-03', advanceAmount: 900, invoiceBalance: 1000 } as never], '2026-09');
    const csv = statementCsv(statement, { d1: 'Acme' });
    expect(csv).not.toMatch(/(^|,)=1\+1/m);
    expect(csv).toContain("'=1+1");
  });
});
