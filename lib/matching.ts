import type { CompanyRecord } from './types';
import { normalizeCompanyName, normalizeEin, normalizePhone, similarity } from './normalize';

export interface DebtorHints {
  name: string | null;
  ein: string | null;
  phone: string | null;
}

/** Score how well extracted debtor details identify a FactorCloud company; null = no match. */
export function scoreDebtor(hints: DebtorHints, debtor: CompanyRecord): { method: string; score: number } | null {
  const ein = normalizeEin(hints.ein);
  if (ein && ein === normalizeEin(debtor.ein)) return { method: 'EIN', score: 1 };
  const name = normalizeCompanyName(hints.name);
  const fcName = normalizeCompanyName(debtor.companyName);
  if (name && name === fcName) return { method: 'Exact name', score: 0.99 };
  const nameScore = name && fcName ? similarity(name, fcName) : 0;
  const phone = normalizePhone(hints.phone);
  const phoneMatch = phone.length >= 10 && phone === normalizePhone(debtor.phone);
  if (phoneMatch && nameScore >= 0.5) return { method: 'Phone + similar name', score: 0.9 };
  if (nameScore >= 0.75) return { method: 'Similar name', score: nameScore * 0.9 };
  return null;
}
