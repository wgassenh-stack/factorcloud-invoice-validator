// The synthetic portfolio behind demo mode (see lib/demo.ts). Deterministic: the same seed gives
// the same clients, debtors and invoices every time, with dates laid out relative to today so the
// dashboards always look current. A few stories are planted on purpose so a demo has something to
// point at: one debtor holding ~45% of the portal client's volume, a volume spike this week, a
// 90+ day invoice, a factor-level concentration in one client and DSO improving over the year.

import type { CheckResult, CompanyRecord, ExtractedFields, ExtractionUsage, ValidationReport } from './types';
import { DEMO_CLIENT_ID } from './demo';

export interface DemoInvoice {
  id: string;
  invoiceNumber: string;
  referenceNumber: string;
  companyClientId: string;
  companyClientName: string;
  companyDebtorId: string;
  companyDebtorName: string;
  invoiceAmount: number;
  invoiceBalance: number;
  advanceAmount: number;
  escrowReserveAmount: number;
  purchaseFeeAmount: number;
  invoiceDate: string;
  createdOn: string;
  fundedDate: string | null;
  paidDate: string | null;
  dueDate: string;
  status: 'PENDING' | 'APPROVED' | 'FUNDED' | 'PAID';
  verificationStatus: 'PENDING' | 'VERIFIED';
  paymentStatus: 'OPEN' | 'PARTIAL' | 'PAID';
  disputed: boolean;
  notes: string | null;
}

export interface DemoReview {
  reviewId: string;
  submissionId: string;
  invoiceId: string;
  clientId: string;
  clientName: string;
  debtorId: string;
  invoiceNumber: string;
  referenceNumber: string;
  invoiceAmount: number;
  invoiceDate: string;
  reason: string;
  checks: CheckResult[];
  createdAt: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED';
  decisionNote: string | null;
  decidedAt: string | null;
}

export interface DemoSubmission {
  submissionId: string;
  invoiceId: string;
  clientId: string;
  debtorId: string;
  validation: ValidationReport;
  files: { fileName: string; documentType: string; sizeBytes: number }[];
  createdAt: string;
  workflowStatus: string;
}

export interface DemoPortfolio {
  today: string;
  clients: CompanyRecord[];
  debtors: CompanyRecord[];
  invoices: DemoInvoice[];
}

interface ClientSpec { name: string; code: string; kind: 'trucking' | 'staffing'; perWeek: number; avg: number; debtorCount: number; city: string; state: string }

const CLIENT_SPECS: ClientSpec[] = [
  { name: '', code: 'WTT', kind: 'trucking', perWeek: 5, avg: 3100, debtorCount: 8, city: 'Fort Worth', state: 'TX' },
  { name: 'Lone Star Haulers Inc', code: 'LSH', kind: 'trucking', perWeek: 20, avg: 3600, debtorCount: 14, city: 'Houston', state: 'TX' },
  { name: 'Blue Ridge Freight LLC', code: 'BRF', kind: 'trucking', perWeek: 6, avg: 2700, debtorCount: 9, city: 'Roanoke', state: 'VA' },
  { name: 'Summit Staffing Group', code: 'SSG', kind: 'staffing', perWeek: 3, avg: 11800, debtorCount: 6, city: 'Denver', state: 'CO' },
  { name: 'Great Plains Logistics', code: 'GPL', kind: 'trucking', perWeek: 7, avg: 2900, debtorCount: 10, city: 'Omaha', state: 'NE' },
  { name: 'Coastal Carriers Co', code: 'CCC', kind: 'trucking', perWeek: 4, avg: 2400, debtorCount: 7, city: 'Savannah', state: 'GA' },
  { name: 'Redline Transport LLC', code: 'RLT', kind: 'trucking', perWeek: 5, avg: 3300, debtorCount: 8, city: 'Memphis', state: 'TN' },
  { name: 'Ironclad Staffing', code: 'ICS', kind: 'staffing', perWeek: 2, avg: 14500, debtorCount: 5, city: 'Cleveland', state: 'OH' },
  { name: 'Prairie Wind Trucking', code: 'PWT', kind: 'trucking', perWeek: 3, avg: 2600, debtorCount: 6, city: 'Wichita', state: 'KS' },
  { name: 'Harbor Point Distribution', code: 'HPD', kind: 'trucking', perWeek: 4, avg: 4200, debtorCount: 7, city: 'Long Beach', state: 'CA' },
  { name: 'Northstar Express', code: 'NSE', kind: 'trucking', perWeek: 5, avg: 2800, debtorCount: 8, city: 'Minneapolis', state: 'MN' },
  { name: 'Sierra Freightways', code: 'SFW', kind: 'trucking', perWeek: 3, avg: 3900, debtorCount: 6, city: 'Reno', state: 'NV' },
  { name: 'Magnolia Staffing Partners', code: 'MSP', kind: 'staffing', perWeek: 2, avg: 9800, debtorCount: 5, city: 'Jackson', state: 'MS' },
  { name: 'Keystone Carriers', code: 'KSC', kind: 'trucking', perWeek: 4, avg: 3000, debtorCount: 7, city: 'Harrisburg', state: 'PA' },
  { name: 'Desert Sun Logistics', code: 'DSL', kind: 'trucking', perWeek: 3, avg: 3500, debtorCount: 6, city: 'Phoenix', state: 'AZ' },
  { name: 'Pinecrest Transport', code: 'PCT', kind: 'trucking', perWeek: 2, avg: 2500, debtorCount: 5, city: 'Asheville', state: 'NC' },
  { name: 'Riverbend Hauling', code: 'RBH', kind: 'trucking', perWeek: 3, avg: 2200, debtorCount: 6, city: 'St. Louis', state: 'MO' },
  { name: 'Copperline Freight', code: 'CLF', kind: 'trucking', perWeek: 2, avg: 3700, debtorCount: 5, city: 'Tucson', state: 'AZ' },
  { name: 'Evergreen Workforce', code: 'EGW', kind: 'staffing', perWeek: 1.5, avg: 12600, debtorCount: 4, city: 'Portland', state: 'OR' },
  { name: 'Midway Motor Lines', code: 'MML', kind: 'trucking', perWeek: 3, avg: 3200, debtorCount: 6, city: 'Indianapolis', state: 'IN' },
];

const DEBTOR_NAMES = [
  'Acme Manufacturing LLC', 'Titan Building Supply', 'Consolidated Freight Brokers', 'Allied Produce Co', 'Heartland Foods Inc',
  'Pinnacle Logistics Group', 'Meridian Steel Works', 'Cascade Paper Products', 'Gulf Coast Chemicals', 'Frontier Grain Cooperative',
  'Bayside Beverage Distributors', 'Granite State Lumber', 'Silverline Brokerage', 'Evercore Packaging', 'Redwood Home Goods',
  'Atlas Auto Parts', 'Crescent City Imports', 'Summit Retail Group', 'Northwind Appliances', 'Prime Poultry Farms',
  'Horizon Health Systems', 'BlueWater Marine Supply', 'Lakeshore Plastics', 'Cardinal Transportation Brokers', 'Trident Electrical Supply',
  'Oakmont Furniture', 'Sunbelt Building Materials', 'Patriot Freight Solutions', 'Golden Harvest Mills', 'Ridgeway Hospital Group',
  'Continental Tire Distribution', 'Harvest Moon Organics', 'Keystone Precision Parts', 'Western Star Brokerage', 'Magnolia Market Stores',
  'Ironwood Construction', 'Valley Fresh Dairy', 'Beacon Medical Supply', 'Highland Hardware', 'Delta Cold Storage',
  'Evergreen Senior Living', 'Coastal Seafood Co', 'Pioneer Energy Services', 'Metro Office Interiors', 'Riverside Poultry',
  'Stonebridge Aggregates', 'Liberty Freight Brokers', 'Sequoia Timber Co', 'Canyon Ridge Hotels', 'Bluebonnet Grocers',
  'Anchor Point Logistics', 'Crossroads Distribution', 'Timberline Cabinets', 'Sterling Glass Works', 'Harborview Hospitality',
  'Prairie Rose Foods', 'Keystone Hospitality Group', 'Apex Industrial Supply', 'Northgate Beverage', 'Lighthouse Fulfillment',
];

const CITIES: [string, string, string][] = [
  ['Dallas', 'TX', '75205'], ['Atlanta', 'GA', '30303'], ['Chicago', 'IL', '60607'], ['Kansas City', 'MO', '64106'], ['Nashville', 'TN', '37203'],
  ['Columbus', 'OH', '43215'], ['Charlotte', 'NC', '28202'], ['Salt Lake City', 'UT', '84101'], ['Sacramento', 'CA', '95814'], ['Tulsa', 'OK', '74103'],
];

const SEED = 20260925;
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 455;

export function buildDemoPortfolio(today: string, anchorClientName: string): DemoPortfolio {
  const rng = mulberry32(SEED);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const iso = (dayOffset: number) => new Date(todayMs - dayOffset * DAY_MS).toISOString().slice(0, 10);

  const debtors: CompanyRecord[] = DEBTOR_NAMES.map((name, i) => {
    const [city, stateCode, zipCode] = CITIES[i % CITIES.length];
    return {
      id: `demo-debtor-${String(i + 1).padStart(2, '0')}`,
      compCode: initials(name) + String(100 + i),
      companyName: name,
      address1: i === 0 ? 'Fake address' : `${100 + Math.floor(rng() * 8900)} ${['Commerce', 'Industrial', 'Market', 'Main', 'Harbor', 'Oak'][i % 6]} ${['St', 'Blvd', 'Ave', 'Pkwy'][i % 4]}`,
      city,
      stateCode,
      zipCode,
      countryCode: 'US',
      phone: i === 0 ? '3343770535' : `${200 + Math.floor(rng() * 700)}555${String(1000 + Math.floor(rng() * 8999))}`,
      email: `ap@${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
      ein: `${10 + Math.floor(rng() * 89)}-${String(1_000_000 + Math.floor(rng() * 8_999_999))}`,
      companyType: 'DEBTOR',
      noBuy: false,
    };
  });
  // Typical days-to-pay per debtor; a handful of slow payers feed the 61-90 and 90+ buckets.
  const payLag = debtors.map((_, i) => (i === 1 ? 88 : i % 7 === 3 ? 52 + rng() * 30 : 24 + rng() * 26));

  const clients: CompanyRecord[] = CLIENT_SPECS.map((spec, i) => ({
    id: i === 0 ? DEMO_CLIENT_ID : `demo-client-${String(i + 1).padStart(2, '0')}`,
    compCode: spec.code,
    companyName: i === 0 ? anchorClientName : spec.name,
    address1: `${200 + i * 37} Commerce Dr`,
    city: spec.city,
    stateCode: spec.state,
    zipCode: String(70000 + i * 311),
    countryCode: 'US',
    phone: `817555${String(2000 + i * 17)}`,
    companyType: 'CLIENT',
    noBuy: false,
  }));

  type Draft = Omit<DemoInvoice, 'id'>;
  const drafts: Draft[] = [];
  const counters = new Map<string, number>();

  const makeInvoice = (clientIndex: number, debtorIndex: number, daysAgo: number, amount: number, opts: { forceOpen?: boolean; disputed?: boolean } = {}): Draft => {
    const spec = CLIENT_SPECS[clientIndex];
    const client = clients[clientIndex];
    const debtor = debtors[debtorIndex];
    const n = (counters.get(client.id) ?? 0) + 1;
    counters.set(client.id, n);
    const invoiceDate = iso(daysAgo);
    // DSO improves over the year: older invoices were paid a bit slower.
    const trend = 1.14 - 0.24 * (1 - daysAgo / HISTORY_DAYS);
    const straggler = rng() < 0.07 ? 1.7 + rng() : 1; // the odd invoice that pays very late
    const lag = Math.max(8, Math.round(payLag[debtorIndex] * trend * straggler + normal(rng) * 6));
    const advanceRate = spec.kind === 'staffing' ? 0.85 : 0.9;

    let status: DemoInvoice['status'];
    const roll = rng();
    if (daysAgo === 0) status = roll < 0.7 ? 'PENDING' : 'APPROVED';
    else if (daysAgo === 1) status = roll < 0.3 ? 'PENDING' : roll < 0.6 ? 'APPROVED' : 'FUNDED';
    else status = 'FUNDED';
    const funded = status === 'FUNDED';
    const fundedOffset = Math.min(daysAgo, 1 + (rng() < 0.3 ? 1 : 0));
    const paid = funded && !opts.forceOpen && lag <= daysAgo;
    const partial = funded && !paid && daysAgo > 20 && rng() < 0.06;
    const balance = paid ? 0 : partial ? round2(amount * (0.4 + rng() * 0.3)) : amount;
    const outstandingDays = paid ? lag : daysAgo;
    const feeRate = Math.min(0.045, 0.015 + 0.0005 * outstandingDays);

    return {
      invoiceNumber: `${spec.code}-${10000 + n}`,
      referenceNumber: `LD${String(100000 + Math.floor(rng() * 899999))}`,
      companyClientId: client.id,
      companyClientName: client.companyName ?? '',
      companyDebtorId: debtor.id,
      companyDebtorName: debtor.companyName ?? '',
      invoiceAmount: amount,
      invoiceBalance: funded ? balance : amount,
      advanceAmount: funded ? round2(amount * advanceRate) : 0,
      escrowReserveAmount: funded ? round2(amount * (1 - advanceRate)) : 0,
      purchaseFeeAmount: funded ? round2(amount * feeRate) : 0,
      invoiceDate: `${invoiceDate}T00:00:00Z`,
      createdOn: `${invoiceDate}T${String(13 + Math.floor(rng() * 8)).padStart(2, '0')}:${String(Math.floor(rng() * 60)).padStart(2, '0')}:00Z`,
      fundedDate: funded ? `${iso(daysAgo - fundedOffset)}T00:00:00Z` : null,
      paidDate: paid ? `${iso(daysAgo - lag)}T00:00:00Z` : null,
      dueDate: `${iso(daysAgo - (spec.kind === 'staffing' ? 45 : 30))}T00:00:00Z`,
      status: paid ? 'PAID' : status,
      verificationStatus: status === 'PENDING' ? 'PENDING' : 'VERIFIED',
      paymentStatus: paid ? 'PAID' : partial ? 'PARTIAL' : 'OPEN',
      disputed: Boolean(opts.disputed) || (funded && !paid && daysAgo > 30 && rng() < 0.04),
      notes: null,
    };
  };

  CLIENT_SPECS.forEach((spec, clientIndex) => {
    // Each client works with its own slice of debtors, weighted so a few carry most volume.
    // Acme (0) and Titan (1) belong to the portal client only; Titan is its slow payer.
    const pool = pickDistinct(rng, DEBTOR_NAMES.length, spec.debtorCount);
    if (clientIndex === 0) pool.push(1);
    const weights = pool.map((_, k) => 1 / (k + 1.2));
    for (let daysAgo = HISTORY_DAYS; daysAgo >= 0; daysAgo--) {
      const weekday = new Date(todayMs - daysAgo * DAY_MS).getUTCDay();
      const weekend = weekday === 0 || weekday === 6;
      const growth = 0.72 + 0.38 * (1 - daysAgo / HISTORY_DAYS);
      const seasonal = 1 + 0.12 * Math.sin(((HISTORY_DAYS - daysAgo) / HISTORY_DAYS) * Math.PI * 2);
      const spike = clientIndex === 0 && daysAgo <= 6 ? 2.3 : 1;
      const expected = (spec.perWeek / 5) * growth * seasonal * spike * (weekend ? 0.15 : 1);
      const count = poisson(rng, expected);
      for (let k = 0; k < count; k++) {
        // The portal client's anchor story: Acme Manufacturing takes ~45% of its volume.
        const debtorIndex = clientIndex === 0 && rng() < 0.45 ? 0 : pool[weighted(rng, weights)];
        const amount = round2(Math.max(350, spec.avg * Math.exp(normal(rng) * 0.42)));
        drafts.push(makeInvoice(clientIndex, debtorIndex, daysAgo, amount));
      }
    }
  });

  // Planted: a 90+ day and a 70+ day invoice on the portal client, both still open.
  drafts.push(makeInvoice(0, 1, 97, 6840, { forceOpen: true }));
  drafts.push(makeInvoice(0, 1, 74, 4215.5, { forceOpen: true, disputed: true }));

  drafts.sort((a, b) => a.createdOn.localeCompare(b.createdOn));
  const invoices = drafts.map((draft, i) => ({ id: `demo-inv-${String(i + 1).padStart(5, '0')}`, ...draft }));
  return { today, clients, debtors, invoices };
}

/** Review items for the factor's queue, attached to recent unverified invoices. */
export function buildDemoReviews(portfolio: DemoPortfolio, now: number): DemoReview[] {
  const pending = portfolio.invoices.filter((inv) => inv.status === 'PENDING').reverse();
  // The first two land on the portal client so its dashboard shows reviews too.
  const own = pending.filter((inv) => inv.companyClientId === DEMO_CLIENT_ID);
  const others = pending.filter((inv) => inv.companyClientId !== DEMO_CLIENT_ID);
  const pick = (i: number) => (i < 2 ? own[i] : others[(i - 2) * 2]) ?? others[i];
  const scenarios: { reason: string; hoursAgo: number; checks: CheckResult[] }[] = [
    { reason: 'Client corrected the invoice amount after verification.', hoursAgo: 0.3, checks: [
      { id: 'client-corrections', label: 'Client corrections', status: 'REVIEW', message: 'The client changed the invoice amount from $4,180.00 to $4,810.00 after document analysis.', comparisons: [{ label: 'Amount', document: '$4,180.00', other: '$4,810.00' }] },
    ] },
    { reason: 'Debtor phone on the invoice does not match FactorCloud.', hoursAgo: 1.4, checks: [
      { id: 'debtor-phone', label: 'Debtor phone matches FactorCloud', status: 'REVIEW', message: 'Phone on the invoice differs from the debtor record.', comparisons: [{ label: 'Phone', document: '(214) 555-0199', other: '(334) 377-0535' }] },
    ] },
    { reason: 'Proof of delivery is not signed.', hoursAgo: 3.2, checks: [
      { id: 'signed-pod', label: 'Signed proof of delivery', status: 'REVIEW', message: 'The POD in this packet has no visible receiver signature.' },
    ] },
    { reason: 'Amount differs between the rate confirmation and the invoice.', hoursAgo: 5.6, checks: [
      { id: 'amount-across-docs', label: 'Amount matches across documents', status: 'REVIEW', message: 'Rate confirmation and invoice totals differ by $150.00 (lumper fee?).', comparisons: [{ label: 'Invoice', document: '$2,950.00', other: 'Rate con $2,800.00' }] },
    ] },
    { reason: 'Duplicate check could not be completed.', hoursAgo: 9.1, checks: [
      { id: 'duplicate-check-incomplete', label: 'Duplicate check', status: 'REVIEW', message: 'FactorCloud\'s invoice list could not be read completely, so a duplicate cannot be ruled out.' },
    ] },
    { reason: 'Invoice is older than the 45-day purchase window.', hoursAgo: 19.5, checks: [
      { id: 'invoice-age', label: 'Invoice age', status: 'REVIEW', message: 'Invoice date is 52 days ago; the purchase window is 45 days.' },
    ] },
    { reason: 'Reference number on the BOL does not match the invoice.', hoursAgo: 28, checks: [
      { id: 'reference-across-docs', label: 'Reference matches across documents', status: 'REVIEW', message: 'BOL shows LD448120, invoice shows LD448210.', comparisons: [{ label: 'Reference', document: 'LD448210', other: 'BOL LD448120' }] },
      { id: 'uncertain-fields', label: 'Extraction confidence', status: 'REVIEW', message: 'Reference number was hard to read on the BOL scan.' },
    ] },
  ];
  const clientName = new Map(portfolio.clients.map((c) => [c.id, c.companyName ?? c.id]));
  return scenarios.flatMap((scenario, i) => {
    const inv = pick(i);
    if (!inv) return [];
    return [{
      reviewId: `demo-review-${i + 1}`,
      submissionId: `demo-sub-${i + 1}`,
      invoiceId: inv.id,
      clientId: inv.companyClientId,
      clientName: clientName.get(inv.companyClientId) ?? inv.companyClientId,
      debtorId: inv.companyDebtorId,
      invoiceNumber: inv.invoiceNumber,
      referenceNumber: inv.referenceNumber,
      invoiceAmount: inv.invoiceAmount,
      invoiceDate: inv.invoiceDate.slice(0, 10),
      reason: scenario.reason,
      checks: scenario.checks,
      createdAt: new Date(now - scenario.hoursAgo * 3_600_000).toISOString(),
      status: 'OPEN' as const,
      decisionNote: null,
      decidedAt: null,
    }];
  });
}

/** Canned document reading for demo mode when no extraction key is configured. */
export function demoExtraction(fileName: string, today: string, anchorClientName: string, debtor: CompanyRecord): { fields: ExtractedFields; usage: ExtractionUsage } {
  const lower = fileName.toLowerCase();
  const documentType: ExtractedFields['documentType'] = /\bbol\b|bill.?of.?lading|[_-]bol/.test(lower) ? 'bol'
    : /pod|proof|delivery/.test(lower) ? 'pod'
      : /rate|confirm|tender/.test(lower) ? 'rate_confirmation'
        : 'invoice';
  const hash = [...fileName].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const invoiceNumber = `INV-${20000 + (hash % 9000)}`;
  // Every file in a demo packet shares one load number (taken from the file name when it has one),
  // so a clean packet passes; rename one file's load number to show a mismatch being caught.
  const reference = fileName.match(/LD\d{4,}/i)?.[0].toUpperCase() ?? 'LD448213';
  const invoiceDate = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const dueDate = new Date(Date.parse(`${invoiceDate}T00:00:00Z`) + 30 * DAY_MS).toISOString().slice(0, 10);
  const isInvoice = documentType === 'invoice';
  const fields: ExtractedFields = {
    documentType,
    invoiceNumber: isInvoice ? invoiceNumber : null,
    referenceNumber: reference,
    documentDate: invoiceDate,
    clientName: anchorClientName,
    debtorName: debtor.companyName ?? null,
    debtorAddress: debtor.address1 ?? null,
    debtorCity: debtor.city ?? null,
    debtorState: debtor.stateCode ?? null,
    debtorZip: debtor.zipCode ?? null,
    debtorPhone: debtor.phone ?? null,
    debtorEmail: null,
    debtorEin: null,
    invoiceAmount: isInvoice || documentType === 'rate_confirmation' ? 4850 : null,
    invoiceDate: isInvoice ? invoiceDate : null,
    dueDate: isInvoice ? dueDate : null,
    signaturePresent: documentType === 'pod' || documentType === 'bol' ? true : null,
    uncertainFields: [],
    notes: 'Demo mode: canned extraction, no document was sent to an AI model.',
  };
  return { fields, usage: { model: 'demo-extractor', inputTokens: 1840, outputTokens: 212, thinkingTokens: 0, totalTokens: 2052, estimatedCostUsd: 0.0011 } };
}

// --- small deterministic helpers -------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

function poisson(rng: () => number, lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = rng();
  while (p > limit) { k++; p *= rng(); }
  return k;
}

function weighted(rng: () => number, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}

function pickDistinct(rng: () => number, n: number, count: number): number[] {
  const chosen: number[] = [];
  while (chosen.length < Math.min(count, n - 2)) {
    const candidate = 2 + Math.floor(rng() * (n - 2));
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }
  return chosen;
}

function initials(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
