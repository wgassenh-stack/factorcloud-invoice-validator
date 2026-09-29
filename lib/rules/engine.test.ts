import { describe, expect, it } from 'vitest';
import { decide, type EngineFacts } from './engine';
import { DEFAULT_SETTINGS, normalizeSettings, type RuleSettings } from './settings';
import type { RiskInvoiceRecord } from '../risk';

const NOW = new Date('2026-09-29T15:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
let seq = 0;
const inv = (over: Partial<RiskInvoiceRecord> = {}): RiskInvoiceRecord => ({
  id: `i${++seq}`, invoiceNumber: `N${seq}`, companyClientId: 'c1', companyDebtorId: 'd1', invoiceAmount: 1000, invoiceBalance: 1000,
  invoiceDate: daysAgo(10), createdOn: daysAgo(10), status: 'FUNDED', fundedDate: daysAgo(9), ...over,
});

/** A client with a steady history across several debtors, paid on time: everything passes. */
function healthy(): EngineFacts {
  const history = [
    ...Array.from({ length: 12 }, (_, i) => inv({ companyDebtorId: `d${(i % 4) + 1}`, invoiceDate: daysAgo(35 + i * 7), createdOn: daysAgo(35 + i * 7), status: 'PAID', paidDate: daysAgo(20), invoiceBalance: 0 })),
    ...Array.from({ length: 4 }, (_, i) => inv({ companyDebtorId: `d${i + 1}`, invoiceDate: daysAgo(5 + i), createdOn: daysAgo(5 + i) })),
  ];
  return {
    invoice: { id: 'new', amount: 800, clientId: 'c1', debtorId: 'd1' },
    paperwork: 'PASS',
    debtorCredit: { debtorId: 'd1', debtorName: 'Acme', limit: 20_000, approved: true, rating: 80, noBuy: false, openBalance: 1000, openCount: 1, thisInvoice: 800 },
    clientCreditLimit: 100_000,
    clientRecords: [...history, inv({ id: 'new', invoiceDate: daysAgo(0), createdOn: daysAgo(0), status: 'PENDING', fundedDate: null })],
    debtorRecords: history.filter((r) => r.companyDebtorId === 'd1'),
    cashReserve: 2500,
    fundedToday: { client: 0, factor: 0 },
    now: NOW,
  };
}
const withSettings = (change: (s: RuleSettings) => void) => { const s = normalizeSettings(structuredClone(DEFAULT_SETTINGS)); change(s); return s; };
const status = (d: ReturnType<typeof decide>, id: string) => d.rules.find((r) => r.id === id)?.status;

describe('funding engine lanes', () => {
  it('all good and within the caps: auto-fund', () => {
    const d = decide(healthy(), DEFAULT_SETTINGS);
    expect(d.rules.filter((r) => !['PASS', 'SKIP'].includes(r.status))).toEqual([]);
    expect(d.outcome).toBe('FUND');
    expect(d.reasons).toEqual([]);
  });

  it('paperwork fine but over the credit limit: approved, needs a click', () => {
    const f = healthy();
    f.debtorCredit = { ...f.debtorCredit!, limit: 1500 };
    const d = decide(f, DEFAULT_SETTINGS);
    expect(d.outcome).toBe('HOLD');
    expect(d.reasons[0]).toMatch(/Over the credit limit: \$1,800 owed with this invoice against a \$1,500 limit/);
  });

  it('sent anyway: review, whatever the money rules say', () => {
    const f = healthy();
    f.paperwork = 'REVIEW';
    expect(decide(f, DEFAULT_SETTINGS).outcome).toBe('REVIEW');
  });

  it('No Buy debtor: review', () => {
    const f = healthy();
    f.debtorCredit = { ...f.debtorCredit!, noBuy: true };
    expect(decide(f, DEFAULT_SETTINGS).outcome).toBe('REVIEW');
  });

  it('anything that could not be checked holds funding (fails safe)', () => {
    const f = healthy();
    f.cashReserve = null;
    const d = decide(f, DEFAULT_SETTINGS);
    expect(d.outcome).toBe('HOLD');
    expect(status(d, 'cash-reserve')).toBe('UNKNOWN');
  });
});

describe('each rule', () => {
  it('negative cash reserve', () => {
    const f = healthy(); f.cashReserve = -50;
    expect(status(decide(f, DEFAULT_SETTINGS), 'cash-reserve')).toBe('HOLD');
  });
  it('credit limit not set or not approved', () => {
    const f = healthy(); f.debtorCredit = { ...f.debtorCredit!, limit: null };
    expect(status(decide(f, DEFAULT_SETTINGS), 'credit-limit')).toBe('HOLD');
    f.debtorCredit = { ...f.debtorCredit!, limit: 20_000, approved: false };
    expect(status(decide(f, DEFAULT_SETTINGS), 'credit-limit')).toBe('HOLD');
  });
  it('client credit limit', () => {
    const f = healthy(); f.clientCreditLimit = 3000;
    expect(status(decide(f, DEFAULT_SETTINGS), 'client-credit')).toBe('HOLD');
    f.clientCreditLimit = null;
    expect(status(decide(f, DEFAULT_SETTINGS), 'client-credit')).toBe('SKIP');
  });
  it("volume spike: Wallace's 10 a month turning into 20", () => {
    const f = healthy();
    const prior = Array.from({ length: 30 }, (_, i) => inv({ companyDebtorId: `d${(i % 4) + 1}`, invoiceDate: daysAgo(31 + i * 3), createdOn: daysAgo(31 + i * 3), status: 'PAID', paidDate: daysAgo(20), invoiceBalance: 0 }));
    const recent = Array.from({ length: 20 }, (_, i) => inv({ companyDebtorId: `d${(i % 4) + 1}`, invoiceDate: daysAgo(1 + i), createdOn: daysAgo(1 + i), status: 'PAID', paidDate: daysAgo(0), invoiceBalance: 0 }));
    f.clientRecords = [...prior, ...recent];
    const d = decide(f, DEFAULT_SETTINGS);
    expect(status(d, 'volume-spike')).toBe('HOLD');
    expect(d.reasons.join(' ')).toMatch(/21 invoices in the last 30 days against about 10 a month/);
  });
  it('slow debtor', () => {
    const f = healthy();
    f.debtorRecords = [inv({ invoiceDate: daysAgo(90), createdOn: daysAgo(90), invoiceBalance: 5000 }), inv({ invoiceDate: daysAgo(5), createdOn: daysAgo(5), invoiceBalance: 1000 })];
    expect(status(decide(f, DEFAULT_SETTINGS), 'slow-debtor')).toBe('HOLD');
  });
  it('first invoice with a debtor', () => {
    const f = healthy(); f.invoice = { ...f.invoice, debtorId: 'd9' };
    expect(status(decide(f, DEFAULT_SETTINGS), 'new-debtor')).toBe('HOLD');
  });
  it('concentration', () => {
    const f = healthy();
    f.clientRecords = f.clientRecords!.map((r) => ({ ...r, companyDebtorId: 'd1' }));
    expect(status(decide(f, DEFAULT_SETTINGS), 'concentration')).toBe('HOLD');
    expect(status(decide(f, withSettings((s) => { s.rules.concentration.enabled = false; })), 'concentration')).toBe('SKIP');
  });
  it('new client', () => {
    const f = healthy(); f.clientRecords = f.clientRecords!.slice(-3);
    expect(status(decide(f, DEFAULT_SETTINGS), 'new-client')).toBe('HOLD');
  });
  it('caps: per invoice, per day, allow-list, business hours', () => {
    const f = healthy(); f.invoice = { ...f.invoice, amount: 6000 };
    expect(status(decide(f, DEFAULT_SETTINGS), 'cap-invoice')).toBe('HOLD');
    const g = healthy(); g.fundedToday = { client: 9500, factor: 9500 };
    expect(status(decide(g, DEFAULT_SETTINGS), 'cap-daily')).toBe('HOLD');
    expect(status(decide(healthy(), withSettings((s) => { s.caps.autoFundClients = ['c2']; })), 'cap-client')).toBe('HOLD');
    const night = healthy(); night.now = new Date('2026-09-29T08:00:00Z'); // 3am in Chicago
    expect(status(decide(night, withSettings((s) => { s.caps.businessHoursOnly = true; })), 'cap-hours')).toBe('HOLD');
  });
});

describe('settings', () => {
  it('fills gaps with defaults and keeps numbers in range', () => {
    const s = normalizeSettings({ mode: 'fund', rules: { concentration: { enabled: false, maxPct: 400 } }, caps: { perInvoice: -5, autoFundClients: ['c1', '', 7] } });
    expect(s.mode).toBe('fund');
    expect(s.rules.concentration).toEqual({ enabled: false, maxPct: 100 });
    expect(s.rules.creditLimit.enabled).toBe(true);
    expect(s.caps.perInvoice).toBe(0);
    expect(s.caps.autoFundClients).toEqual(['c1']);
    expect(normalizeSettings({ mode: 'yolo' }).mode).toBe('suggest');
  });
});
