// Deterministic normalizers. The AI only extracts; every comparison runs through
// these so that "(334) 377-0535" and "+13343770535" compare equal.

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Digits only, dropping a leading US country code. */
export function normalizePhone(value: string | null | undefined): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** Parse "$12,500.00", "12500", 12500 into a number rounded to cents. */
export function normalizeMoney(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const negative = /^\s*\(.*\)\s*$/.test(value) || /^\s*-/.test(value);
  const cleaned = value.replace(/[^0-9.]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round((negative ? -n : n) * 100) / 100;
}

/** Canonical YYYY-MM-DD, or '' when the value can't be read as a date. */
export function normalizeDate(value: string | null | undefined): string {
  if (!value) return '';
  const v = value.trim();
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return ymd(year, +m[1], +m[2]); // US month/day order
  }
  const parsed = new Date(v);
  if (!Number.isNaN(parsed.getTime())) {
    return ymd(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
  }
  return '';
}

function ymd(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const COMPANY_SUFFIXES = new Set([
  'llc', 'l l c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'ltd', 'limited', 'lp', 'llp', 'plc', 'pllc',
]);

const COMPANY_ABBREVIATIONS: Record<string, string> = {
  mfg: 'manufacturing', mfr: 'manufacturing', intl: 'international', natl: 'national',
  svc: 'services', svcs: 'services', dist: 'distribution', distrib: 'distribution',
  assoc: 'associates', bros: 'brothers', trans: 'transportation', transp: 'transportation',
  logist: 'logistics', ent: 'enterprises', ind: 'industries', inds: 'industries',
};

/** Lowercase, "&" -> "and", punctuation stripped, common abbreviations expanded, legal suffixes removed. */
export function normalizeCompanyName(value: string | null | undefined): string {
  if (!value) return '';
  const words = value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => COMPANY_ABBREVIATIONS[w] ?? w);
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

/** Dice coefficient on character bigrams; 1 = identical. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) ?? 0) + 1);
    }
    return map;
  };
  const x = bigrams(a);
  const y = bigrams(b);
  let overlap = 0;
  for (const [g, n] of x) overlap += Math.min(n, y.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

const STREET_ABBREVIATIONS: Record<string, string> = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', lane: 'ln',
  boulevard: 'blvd', court: 'ct', place: 'pl', parkway: 'pkwy', highway: 'hwy',
  circle: 'cir', terrace: 'ter', trail: 'trl', square: 'sq', expressway: 'expy',
  freeway: 'fwy', suite: 'ste', apartment: 'apt', building: 'bldg', floor: 'fl',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
};

/** Lowercase, punctuation stripped, USPS-style abbreviations applied. */
export function normalizeStreet(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/#/g, ' # ')
    .replace(/[^a-z0-9# ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_ABBREVIATIONS[w] ?? w)
    .join(' ');
}

export function normalizeCity(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

export function normalizeState(value: string | null | undefined): string {
  if (!value) return '';
  const v = value.trim().toLowerCase().replace(/\./g, '');
  if (v.length === 2) return v.toUpperCase();
  return STATE_CODES[v] ?? v.toUpperCase();
}

/** First five digits of a US ZIP. */
export function normalizeZip(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\D/g, '').slice(0, 5);
}

export function normalizeEin(value: string | null | undefined): string {
  return value ? value.replace(/\D/g, '') : '';
}

export function normalizeEmail(value: string | null | undefined): string {
  return value ? value.trim().toLowerCase() : '';
}

/** Case/whitespace/punctuation-insensitive identifier (invoice #, load #). */
export function normalizeIdentifier(value: string | null | undefined): string {
  return value ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
