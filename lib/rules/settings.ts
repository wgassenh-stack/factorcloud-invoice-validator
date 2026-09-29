// The factor's rules for the funding engine: every threshold is a setting, and every rule can be
// switched off. Pure, so the settings page, the engine and the tests share one definition.

/** How far the engine may go on its own. */
export type EngineMode = 'off' | 'suggest' | 'approve' | 'fund';

export interface RuleSettings {
  mode: EngineMode;
  /** Mark invoices verified (method "ONLINE PORTAL") before approving them for funding. */
  markVerified: boolean;
  rules: {
    creditLimit: { enabled: boolean };
    clientCreditLimit: { enabled: boolean };
    slowDebtor: { enabled: boolean; maxPastDuePct: number; pastDueDays: number };
    newDebtor: { enabled: boolean };
    concentration: { enabled: boolean; maxPct: number };
    cashReserve: { enabled: boolean };
    volumeSpike: { enabled: boolean; maxMultiple: number };
    newClient: { enabled: boolean; minDays: number; minInvoices: number };
  };
  caps: {
    perInvoice: number;
    perClientPerDay: number;
    perFactorPerDay: number;
    businessHoursOnly: boolean;
    /** Clients the engine may fund on its own: "all", or a list of FactorCloud client IDs. */
    autoFundClients: 'all' | string[];
  };
}

export const DEFAULT_SETTINGS: RuleSettings = {
  mode: 'suggest',
  markVerified: true,
  rules: {
    creditLimit: { enabled: true },
    clientCreditLimit: { enabled: true },
    slowDebtor: { enabled: true, maxPastDuePct: 25, pastDueDays: 60 },
    newDebtor: { enabled: true },
    concentration: { enabled: true, maxPct: 40 },
    cashReserve: { enabled: true },
    volumeSpike: { enabled: true, maxMultiple: 2 },
    newClient: { enabled: true, minDays: 30, minInvoices: 10 },
  },
  caps: { perInvoice: 5_000, perClientPerDay: 10_000, perFactorPerDay: 25_000, businessHoursOnly: false, autoFundClients: 'all' },
};

const MODES: EngineMode[] = ['off', 'suggest', 'approve', 'fund'];
const num = (value: unknown, fallback: number, min: number, max: number) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

/** Stored or submitted settings, made whole and safe: unknown keys dropped, numbers kept in range. */
export function normalizeSettings(input: unknown): RuleSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
  const d = DEFAULT_SETTINGS;
  const r = (src.rules ?? {}) as Record<string, any>;
  const c = (src.caps ?? {}) as Record<string, any>;
  const on = (key: keyof RuleSettings['rules']) => bool(r[key]?.enabled, d.rules[key].enabled);
  const clients = Array.isArray(c.autoFundClients)
    ? c.autoFundClients.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0).map((id: string) => id.trim()).slice(0, 500)
    : 'all';
  return {
    mode: MODES.includes(src.mode) ? src.mode : d.mode,
    markVerified: bool(src.markVerified, d.markVerified),
    rules: {
      creditLimit: { enabled: on('creditLimit') },
      clientCreditLimit: { enabled: on('clientCreditLimit') },
      slowDebtor: { enabled: on('slowDebtor'), maxPastDuePct: num(r.slowDebtor?.maxPastDuePct, 25, 0, 100), pastDueDays: num(r.slowDebtor?.pastDueDays, 60, 1, 365) },
      newDebtor: { enabled: on('newDebtor') },
      concentration: { enabled: on('concentration'), maxPct: num(r.concentration?.maxPct, 40, 1, 100) },
      cashReserve: { enabled: on('cashReserve') },
      volumeSpike: { enabled: on('volumeSpike'), maxMultiple: num(r.volumeSpike?.maxMultiple, 2, 1, 20) },
      newClient: { enabled: on('newClient'), minDays: num(r.newClient?.minDays, 30, 0, 3650), minInvoices: num(r.newClient?.minInvoices, 10, 0, 10_000) },
    },
    caps: {
      perInvoice: num(c.perInvoice, d.caps.perInvoice, 0, 10_000_000),
      perClientPerDay: num(c.perClientPerDay, d.caps.perClientPerDay, 0, 100_000_000),
      perFactorPerDay: num(c.perFactorPerDay, d.caps.perFactorPerDay, 0, 1_000_000_000),
      businessHoursOnly: bool(c.businessHoursOnly, d.caps.businessHoursOnly),
      autoFundClients: clients,
    },
  };
}
