// FactorCloud invoice labels, as its web app reads them (GET /labels?entityType=INVOICE). Pure.

export interface InvoiceLabel { id: string; name: string }

/** Every {id, name} in a label response, whatever it is wrapped in. */
export function labelsIn(body: unknown): InvoiceLabel[] {
  const found: InvoiceLabel[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === 'string' && typeof obj.name === 'string') { found.push({ id: obj.id, name: obj.name }); return; }
    Object.values(obj).forEach((item) => visit(item, depth + 1));
  };
  visit(body, 0);
  return found;
}

