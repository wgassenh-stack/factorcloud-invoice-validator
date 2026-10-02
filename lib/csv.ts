// One rule for every CSV the portal exports. Invoice numbers, names and notes come from clients and
// FactorCloud, so text that a spreadsheet would run as a formula (starting with = + - @, a tab or a
// carriage return) gets a leading apostrophe. Plain numbers, negative ones included, are left as
// numbers. See OWASP "CSV Injection".

const NUMBER = /^-?\d+(\.\d+)?$/;
const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = value == null ? '' : String(value);
  if (FORMULA.test(text.trimStart()) && !NUMBER.test(text.trim())) text = `'${text}`;
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRows(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
