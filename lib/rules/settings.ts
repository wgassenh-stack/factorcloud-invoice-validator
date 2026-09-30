// The factor's rules for the funding engine: every threshold is a setting, and every rule can be
// switched off. Pure, so the settings page, the engine and the tests share one definition.

/** How far the engine may go on its own. */
export type EngineMode = 'off' | 'suggest' | 'approve' | 'fund';

export interface RuleSettings {
  /** Pause all automation: every client acts as Off, whatever its own rules say. */
  paused: boolean;
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
  /**
   * Per-client rules, keyed by FactorCloud client ID. A client with an entry uses its own mode, rule
   * switches and thresholds, and per-invoice and daily client caps; the factor-wide cap, business
   * hours and the auto-fund allow-list always come from the factor defaults.
   */
  clientOverrides: Record<string, ClientOverride>;
}

export interface ClientOverride {
  name: string;
  mode: EngineMode;
  rules: RuleSettings['rules'];
  caps: { perInvoice: number; perClientPerDay: number };
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
  clientOverrides: {},
  paused: false,
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
  const base = normalizeBase(src);
  const overrides: Record<string, ClientOverride> = {};
  const raw = src.clientOverrides && typeof src.clientOverrides === 'object' && !Array.isArray(src.clientOverrides) ? src.clientOverrides as Record<string, any> : {};
  for (const [id, value] of Object.entries(raw).slice(0, 500)) {
    const key = id.trim();
    if (!key || !value || typeof value !== 'object') continue;
    const clean = normalizeBase(value);
    overrides[key] = {
      name: typeof value.name === 'string' ? value.name.slice(0, 200) : key,
      mode: clean.mode,
      rules: clean.rules,
      caps: { perInvoice: clean.caps.perInvoice, perClientPerDay: clean.caps.perClientPerDay },
    };
  }
  return { ...base, paused: bool(src.paused, false), clientOverrides: overrides };
}

/** The rules that apply to one client: its override when it has one, otherwise the factor defaults. */
export function settingsForClient(settings: RuleSettings, clientId: string | null | undefined): RuleSettings {
  const override = clientId ? settings.clientOverrides?.[clientId] : undefined;
  const merged = override ? { ...settings, mode: override.mode, rules: override.rules, caps: { ...settings.caps, ...override.caps } } : settings;
  // Pausing wins over every client's own rules.
  return settings.paused ? { ...merged, mode: 'off' } : merged;
}

/** How many clients each mode applies to, once client rules and the pause are taken into account. */
export function effectiveModes(settings: RuleSettings, clientIds: string[]): Record<EngineMode, number> {
  const counts: Record<EngineMode, number> = { off: 0, suggest: 0, approve: 0, fund: 0 };
  for (const id of clientIds) counts[settingsForClient(settings, id).mode] += 1;
  return counts;
}

/** A new override for a client, starting from the factor defaults. */
export function overrideFrom(settings: RuleSettings, name: string): ClientOverride {
  return { name, mode: settings.mode, rules: structuredClone(settings.rules), caps: { perInvoice: settings.caps.perInvoice, perClientPerDay: settings.caps.perClientPerDay } };
}

function normalizeBase(src: Record<string, any>): Omit<RuleSettings, 'clientOverrides' | 'paused'> {
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
