import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RULES, validate } from '../lib/rules';
import type { AnalyzedDocument, CompanyRecord, ExtractedFields } from '../lib/types';

// Sandbox records from HANDOFF.md.
const ACME: CompanyRecord = {
  id: 'a3429767-8107-4f1e-98f7-ecb910e930d4',
  compCode: 'ACME1',
  companyName: 'Acme Manufacturing LLC',
  address1: 'Fake address',
  city: 'Dallas',
  stateCode: 'TX',
  zipCode: '75205',
  phone: '3343770535',
  ein: '987654321',
  noBuy: false,
};
const CLIENT: CompanyRecord = { id: 'd9492b53-6545-48d6-87cf-c09ff1cdfc62', companyName: "Will's Test Trucking LLC" };

function fields(overrides: Partial<ExtractedFields> = {}): ExtractedFields {
  return {
    documentType: 'invoice',
    invoiceNumber: 'Test004',
    referenceNumber: 'Load004',
    clientName: "Will's Test Trucking LLC",
    debtorName: 'Acme Manufacturing LLC',
    debtorAddress: 'Fake Address',
    debtorCity: 'Dallas',
    debtorState: 'TX',
    debtorZip: '75205',
    debtorPhone: '(334) 377-0535',
    debtorEmail: null,
    debtorEin: null,
    invoiceAmount: 12500,
    invoiceDate: '2026-09-24',
    dueDate: null,
    signaturePresent: null,
    uncertainFields: [],
    notes: null,
    ...overrides,
  };
}

const doc = (f: Partial<ExtractedFields> = {}, fileName = 'invoice.pdf'): AnalyzedDocument => ({ fileName, fields: fields(f) });
const run = (documents: AnalyzedDocument[], debtor: CompanyRecord | null = ACME) =>
  validate({ documents, primaryIndex: 0, debtor, client: CLIENT, today: '2026-09-24' });
const statusOf = (r: ReturnType<typeof run>, id: string) => r.checks.find((c) => c.id === id)?.status;

test('clean invoice passes', () => {
  const r = run([doc()]);
  assert.equal(r.status, 'PASS', JSON.stringify(r.checks.filter((c) => c.status !== 'PASS' && c.status !== 'SKIP')));
});

test('address and phone mismatches go to REVIEW with both values shown', () => {
  const r = run([doc({ debtorAddress: '123 Main Street', debtorPhone: '214-555-0100' })]);
  assert.equal(r.status, 'REVIEW');
  const address = r.checks.find((c) => c.id === 'address')!;
  assert.equal(address.status, 'REVIEW');
  assert.deepEqual(address.comparisons![0], { label: 'Street', document: '123 Main Street', other: 'Fake address' });
  assert.equal(statusOf(r, 'phone'), 'REVIEW');
});

test('missing debtor fails', () => {
  assert.equal(run([doc()], null).status, 'FAIL');
});

test('no-buy debtor fails', () => {
  assert.equal(run([doc()], { ...ACME, noBuy: true }).status, 'FAIL');
});

test('missing invoice amount fails', () => {
  assert.equal(statusOf(run([doc({ invoiceAmount: null })]), 'required-fields'), 'FAIL');
});

test('supporting document with a different amount goes to REVIEW', () => {
  const r = run([doc(), doc({ documentType: 'rate_confirmation', invoiceNumber: null, invoiceAmount: 10000 }, 'ratecon.pdf')]);
  assert.equal(statusOf(r, 'amount-across-docs'), 'REVIEW');
  assert.equal(r.status, 'REVIEW');
});

test('matching supporting documents pass cross-document checks', () => {
  const r = run([
    doc(),
    doc({ documentType: 'bol', invoiceNumber: null, invoiceAmount: null, referenceNumber: 'LOAD-004', invoiceDate: '09/24/2026' }, 'bol.pdf'),
  ]);
  assert.equal(statusOf(r, 'reference-across-docs'), 'PASS');
  assert.equal(statusOf(r, 'amount-across-docs'), 'SKIP');
  assert.equal(r.status, 'PASS');
});

test('reference mismatch across documents goes to REVIEW', () => {
  const r = run([doc(), doc({ documentType: 'pod', referenceNumber: 'Load999' }, 'pod.pdf')]);
  assert.equal(statusOf(r, 'reference-across-docs'), 'REVIEW');
});

test('fuzzy company names pass only when enabled', () => {
  const docs = [doc({ debtorName: 'Acme Manufacturng LLC' })]; // typo
  assert.equal(statusOf(run(docs), 'company-name'), 'PASS');
  const strict = validate({ documents: docs, primaryIndex: 0, debtor: ACME, client: CLIENT, today: '2026-09-24', rules: { ...RULES, allowFuzzyCompanyName: false } });
  assert.equal(statusOf(strict, 'company-name'), 'REVIEW');
});

test('old invoices and uncertain fields go to REVIEW', () => {
  assert.equal(statusOf(run([doc({ invoiceDate: '2026-06-01' })]), 'invoice-age'), 'REVIEW');
  assert.equal(statusOf(run([doc({ uncertainFields: ['debtorPhone'] })]), 'extraction-confidence'), 'REVIEW');
});

test('disabled rules are skipped', () => {
  const r = validate({
    documents: [doc({ debtorPhone: '000' })],
    primaryIndex: 0,
    debtor: ACME,
    client: CLIENT,
    today: '2026-09-24',
    rules: { ...RULES, requirePhoneMatch: false },
  });
  assert.equal(statusOf(r, 'phone'), 'SKIP');
  assert.equal(r.status, 'PASS');
});
