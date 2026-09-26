'use client';

import { demoMode } from '@/lib/demo';

/** Marks every screen in demo mode so synthetic numbers are never mistaken for a real portfolio. */
export function DemoBadge({ floating = false }: { floating?: boolean }) {
  if (!demoMode()) return null;
  return <span className={`demoBadge ${floating ? 'demoRibbon' : ''}`} title="Synthetic portfolio. Nothing here is real client data and nothing is sent to FactorCloud."><i />Demo data</span>;
}
