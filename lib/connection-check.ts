import 'server-only';

import { publicErrorMessage } from './api-errors';
import { allowedDebtorIds, getClientDebtor, getCompany, getInvoice, listInvoiceLabels, listInvoices } from './factorcloud';
import { findReviewLabel, reviewLabelName } from './review-label';
import { PORTAL_NOTE } from './portal-notes';
import { fairCoverage, valueCounts, type FieldCoverage, type ValueCounts } from './field-coverage';
import { collectRiskInvoiceRecords, type RiskInvoiceRecord } from './risk';

// A read-only tour of every FactorCloud call the portal depends on, plus how much of the invoice
// data comes back filled in. Nothing is created, uploaded or changed in FactorCloud.

export type CheckState = 'ok' | 'warn' | 'fail' | 'skip';

export interface ConnectionItem {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
  ms?: number;
}

export interface ConnectionReport {
  generatedAt: string;
  scope: 'client' | 'factor';
  invoiceCount: number;
  items: ConnectionItem[];
  coverage: FieldCoverage[];
  values: ValueCounts[];
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const start = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - start };
  } catch (error) {
    return { error, ms: Date.now() - start };
  }
}

const fail = (err: unknown) => publicErrorMessage(err, 'connection-check');
const pct = (share: number) => `${Math.round(share * 100)}%`;

export async function runConnectionCheck(opts: { clientId: string | null; scope: 'client' | 'factor' }): Promise<ConnectionReport> {
  const items: ConnectionItem[] = [];

  // 1. Settings the portal needs (reported as present/missing only; values never leave the server).
  const missing = [
    !process.env.FACTORCLOUD_FACTOR_ID && 'FACTORCLOUD_FACTOR_ID',
    !process.env.FACTORCLOUD_BEARER_TOKEN && 'FACTORCLOUD_BEARER_TOKEN',
    opts.scope === 'client' && !opts.clientId && 'FACTORCLOUD_CLIENT_ID',
    !process.env.PORTAL_SIGNING_SECRET && 'PORTAL_SIGNING_SECRET',
  ].filter(Boolean) as string[];
  items.push({ id: 'settings', label: 'Portal settings', state: missing.length ? 'fail' : 'ok', detail: missing.length ? `Missing: ${missing.join(', ')}.` : 'FactorCloud and signing settings are all set.' });
  const extraction = Boolean(process.env.GEMINI_API_KEY || process.env.AI_API_KEY);
  items.push({ id: 'extraction', label: 'Document reading (Gemini)', state: extraction ? 'ok' : 'warn', detail: extraction ? `Key set; model ${process.env.EXTRACTION_MODEL || 'gemini-3.5-flash-lite'}. Not called by this check.` : 'GEMINI_API_KEY is not set, so uploads cannot be read.' });

  // 2. Sign-in and the client record.
  if (opts.clientId) {
    const client = await timed(() => getCompany(opts.clientId!));
    items.push(client.value
      ? { id: 'client', label: 'Sign-in and client record', state: 'ok', detail: `Read ${client.value.companyName || client.value.compCode || 'the client'} (GET /companies/{id}).`, ms: client.ms }
      : { id: 'client', label: 'Sign-in and client record', state: 'fail', detail: fail(client.error), ms: client.ms });
  }

  // 3. The invoice list, every page.
  const list = await timed(() => listInvoices(opts.scope === 'client' && opts.clientId ? { client: opts.clientId } : {}));
  let records: RiskInvoiceRecord[] = [];
  if (list.value) {
    records = collectRiskInvoiceRecords(list.value.raw);
    if (opts.scope === 'client' && opts.clientId) records = records.filter((r) => r.companyClientId === opts.clientId);
    items.push({
      id: 'invoices', label: 'Invoice list', state: list.value.complete ? (records.length ? 'ok' : 'warn') : 'warn', ms: list.ms,
      detail: list.value.complete
        ? `${records.length} invoice${records.length === 1 ? '' : 's'} across ${list.value.pages} page${list.value.pages === 1 ? '' : 's'}.${records.length ? '' : ' Charts will be empty until there are invoices.'}`
        : `Read ${records.length} invoices but the list is incomplete: ${list.value.incompleteReason ?? 'unknown reason'}`,
    });
  } else {
    items.push({ id: 'invoices', label: 'Invoice list', state: 'fail', detail: fail(list.error), ms: list.ms });
  }

  // 4. One invoice in detail.
  const sample = records.find((r) => r.status && !/REJECT|CANCEL/i.test(r.status)) ?? records[0];
  if (sample) {
    const detail = await timed(() => getInvoice(sample.id));
    items.push(detail.value
      ? { id: 'invoice-detail', label: 'Invoice detail', state: 'ok', detail: `Read invoice ${sample.invoiceNumber ?? sample.id} (GET /invoices/{id}).`, ms: detail.ms }
      : { id: 'invoice-detail', label: 'Invoice detail', state: detail.error ? 'fail' : 'warn', detail: detail.error ? fail(detail.error) : 'FactorCloud returned no record for a listed invoice.', ms: detail.ms });
  } else {
    items.push({ id: 'invoice-detail', label: 'Invoice detail', state: 'skip', detail: 'No invoice to read yet.' });
  }

  // 5. Credit terms for the busiest debtor (the credit check on the submit page uses this).
  const debtorCounts = new Map<string, number>();
  for (const r of records) if (r.companyDebtorId && r.companyClientId) debtorCounts.set(`${r.companyClientId}|${r.companyDebtorId}`, (debtorCounts.get(`${r.companyClientId}|${r.companyDebtorId}`) ?? 0) + 1);
  const busiest = [...debtorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (busiest) {
    const [clientId, debtorId] = busiest.split('|');
    const terms = await timed(() => getClientDebtor(clientId, debtorId));
    if (terms.error) items.push({ id: 'credit', label: 'Debtor credit terms', state: 'fail', detail: fail(terms.error), ms: terms.ms });
    else if (!terms.value) items.push({ id: 'credit', label: 'Debtor credit terms', state: 'warn', detail: 'No client–debtor record for the busiest debtor (GET /clients/{client}/debtors/{debtor} returned nothing). The credit check will say "no limit set".', ms: terms.ms });
    else items.push({
      id: 'credit', label: 'Debtor credit terms', ms: terms.ms,
      state: terms.value.creditLimit && terms.value.creditLimit > 0 ? 'ok' : 'warn',
      detail: terms.value.creditLimit && terms.value.creditLimit > 0
        ? `Read a credit limit${terms.value.creditLimitApproved === false ? ' (not approved)' : ''} for the busiest debtor. The credit check will work.`
        : 'The busiest debtor has no credit limit set, so the credit check will say "no limit set".',
    });
  } else {
    items.push({ id: 'credit', label: 'Debtor credit terms', state: 'skip', detail: 'No debtor on any invoice yet.' });
  }

  // 6. The debtors this portal matches uploads against.
  // The same list uploads are matched against (FACTORCLOUD_DEBTOR_IDS, or the demo debtors).
  const configured = await allowedDebtorIds();
  if (configured.length) {
    const results = await Promise.all(configured.map((id) => timed(() => getCompany(id))));
    const good = results.filter((r) => r.value).length;
    items.push({ id: 'debtors', label: 'Matchable debtors', state: good === configured.length ? 'ok' : good ? 'warn' : 'fail', detail: `${good} of ${configured.length} debtors in FACTORCLOUD_DEBTOR_IDS could be read.` });
  } else {
    items.push({ id: 'debtors', label: 'Matchable debtors', state: 'warn', detail: 'FACTORCLOUD_DEBTOR_IDS is empty, so uploads cannot be matched to a debtor.' });
  }

  // 7. Labels and notes: how FactorCloud describes a label, so the portal can put one on the
  // invoices it flags, and whether the portal's note survives on invoices it created.
  items.push(...await labelsAndNotes(records));

  items.push({ id: 'writes', label: 'Creating invoices and attaching documents', state: 'skip', detail: 'Not tested here, because it would change FactorCloud. Submit one test invoice to confirm.' });

  // 8. Field coverage: will the dashboards have numbers to show?
  const coverage = fairCoverage(records);
  const thin = coverage.filter((c) => c.total > 0 && c.share < 0.5);
  if (records.length) {
    items.push({
      id: 'coverage', label: 'Dashboard data', state: thin.length ? 'warn' : 'ok',
      detail: thin.length
        ? `Mostly empty: ${thin.map((c) => `${c.label} (${pct(c.share)})`).join(', ')}. Features that use them will show little or nothing.`
        : 'Every field the dashboards use is filled in on most invoices.',
    });
  }

  return { generatedAt: new Date().toISOString(), scope: opts.scope, invoiceCount: records.length, items, coverage, values: valueCounts(records) };
}

function invoiceOf(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  for (const key of ['invoice', 'data']) if (obj[key] && typeof obj[key] === 'object') return obj[key] as Record<string, unknown>;
  return obj;
}

const clip = (value: unknown, max = 600) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

async function labelsAndNotes(records: RiskInvoiceRecord[]): Promise<ConnectionItem[]> {
  const items: ConnectionItem[] = [];
  // The most recently created invoices, read one by one (the list may leave labels out).
  const recent = records.slice().sort((a, b) => String(b.createdOn ?? b.invoiceDate ?? '').localeCompare(String(a.createdOn ?? a.invoiceDate ?? ''))).slice(0, 15);
  const details = await Promise.all(recent.map(async (record) => ({ record, invoice: invoiceOf(await getInvoice(record.id).catch(() => null)) })));

  const labelled = details.find((d) => Array.isArray(d.invoice?.labels) && (d.invoice!.labels as unknown[]).length);
  items.push(labelled
    ? { id: 'labels', label: 'Invoice labels', state: 'ok', detail: `Invoice ${labelled.record.invoiceNumber ?? labelled.record.id} has labels: ${clip(labelled.invoice!.labels)}` }
    : { id: 'labels', label: 'Invoice labels', state: 'warn', detail: `None of the ${details.length} newest invoices has a label${details[0]?.invoice && 'labels' in details[0].invoice ? ` (the field comes back as ${clip(details[0].invoice.labels, 80)})` : ''}. Add one in FactorCloud to see its format.` });

  // The label flagged invoices get (see lib/review-label.ts).
  const catalog = await timed(() => listInvoiceLabels());
  if (catalog.value) {
    const review = process.env.FACTORCLOUD_REVIEW_LABEL_ID?.trim() ? null : findReviewLabel(catalog.value);
    items.push(process.env.FACTORCLOUD_REVIEW_LABEL_ID?.trim()
      ? { id: 'label-catalog', label: 'Review label', state: 'ok', detail: 'Flagged invoices get the label set in FACTORCLOUD_REVIEW_LABEL_ID.', ms: catalog.ms }
      : review
        ? { id: 'label-catalog', label: 'Review label', state: 'ok', detail: `Flagged invoices get the "${review.name}" label (${catalog.value.length} invoice labels in FactorCloud).`, ms: catalog.ms }
        : { id: 'label-catalog', label: 'Review label', state: 'warn', detail: `No "${reviewLabelName()}" label among FactorCloud's ${catalog.value.length} invoice labels (${catalog.value.map((l) => l.name).slice(0, 8).join(', ') || 'none'}). Create it in FactorCloud so flagged invoices stand out.`, ms: catalog.ms });
  } else {
    items.push({ id: 'label-catalog', label: 'Review label', state: 'warn', detail: `Could not read FactorCloud's invoice labels (GET /labels?entityType=INVOICE): ${fail(catalog.error)}`, ms: catalog.ms });
  }

  const portal = details.find((d) => typeof d.record.notes === 'string' && d.record.notes.includes(PORTAL_NOTE)) ?? details.find((d) => typeof d.invoice?.notes === 'string' && (d.invoice.notes as string).includes(PORTAL_NOTE));
  items.push(portal
    ? { id: 'notes', label: "Portal's invoice note", state: 'ok', detail: `Invoice ${portal.record.invoiceNumber ?? portal.record.id} keeps it: ${clip(portal.invoice?.notes ?? portal.record.notes, 300)}` }
    : { id: 'notes', label: "Portal's invoice note", state: 'warn', detail: `None of the ${details.length} newest invoices carries the portal's note${details[0]?.invoice ? ` (notes on the newest: ${clip(details[0].invoice.notes ?? null, 120)})` : ''}. FactorCloud may be dropping it.` });
  return items;
}
