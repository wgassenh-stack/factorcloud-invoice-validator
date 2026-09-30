import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings, overrideFrom, settingsForClient } from './settings';

describe('client rules', () => {
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS, mode: 'approve', caps: { ...DEFAULT_SETTINGS.caps, perFactorPerDay: 40_000, businessHoursOnly: true },
    clientOverrides: { big: { name: 'Big Co', mode: 'fund', rules: { concentration: { enabled: false } }, caps: { perInvoice: 20_000, perClientPerDay: 50_000, perFactorPerDay: 1 } } },
  });

  it('a client with its own rules uses them; the factor-wide limits still come from the defaults', () => {
    const big = settingsForClient(settings, 'big');
    expect(big.mode).toBe('fund');
    expect(big.rules.concentration.enabled).toBe(false);
    expect(big.caps).toMatchObject({ perInvoice: 20_000, perClientPerDay: 50_000, perFactorPerDay: 40_000, businessHoursOnly: true });
  });

  it('any other client uses the factor defaults', () => {
    expect(settingsForClient(settings, 'other')).toBe(settings);
    expect(settingsForClient(settings, null).mode).toBe('approve');
  });

  it('cleans stored overrides: bad modes, out-of-range numbers and junk entries', () => {
    const clean = normalizeSettings({ clientOverrides: { a: { mode: 'yolo', caps: { perInvoice: -5 } }, ' ': { mode: 'fund' }, b: 'nope' } });
    expect(Object.keys(clean.clientOverrides)).toEqual(['a']);
    expect(clean.clientOverrides.a).toMatchObject({ name: 'a', mode: DEFAULT_SETTINGS.mode, caps: { perInvoice: 0, perClientPerDay: DEFAULT_SETTINGS.caps.perClientPerDay } });
  });

  it('a new client override starts as a copy of the defaults', () => {
    const o = overrideFrom(settings, 'New Co');
    expect(o).toMatchObject({ name: 'New Co', mode: 'approve', caps: { perInvoice: 5_000, perClientPerDay: 10_000 } });
    o.rules.creditLimit.enabled = false;
    expect(settings.rules.creditLimit.enabled).toBe(true);
  });
});
