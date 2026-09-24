import { describe, expect, it } from 'vitest';
import {
  normalizeCompanyName,
  normalizeDate,
  normalizeIdentifier,
  normalizeMoney,
  normalizePhone,
  normalizeStreet,
} from './normalize';

describe('normalizers', () => {
  it('normalizes US phone numbers', () => {
    expect(normalizePhone('+1 (334) 377-0535')).toBe('3343770535');
    expect(normalizePhone('334-377-0535')).toBe('3343770535');
  });

  it('normalizes money to cents', () => {
    expect(normalizeMoney('$12,500.009')).toBe(12500.01);
    expect(normalizeMoney('(125.50)')).toBe(-125.5);
  });

  it('rejects impossible calendar dates', () => {
    expect(normalizeDate('2026-02-28')).toBe('2026-02-28');
    expect(normalizeDate('2026-02-31')).toBe('');
    expect(normalizeDate('02/31/2026')).toBe('');
  });

  it('normalizes common company abbreviations and legal suffixes', () => {
    expect(normalizeCompanyName('Acme Mfg., LLC')).toBe('acme manufacturing');
    expect(normalizeCompanyName('ACME Manufacturing Inc.')).toBe('acme manufacturing');
  });

  it('normalizes common street terms', () => {
    expect(normalizeStreet('123 Main Street, Suite 5')).toBe('123 main st ste 5');
  });

  it('normalizes invoice and load identifiers', () => {
    expect(normalizeIdentifier('INV-001 / A')).toBe('INV001A');
  });
});
