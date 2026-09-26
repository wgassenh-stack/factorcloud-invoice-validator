'use client';

import { useEffect, useState } from 'react';
import { demoInBrowser } from '@/lib/demo';

/** Marks every screen in demo mode so synthetic numbers are never mistaken for a real portfolio. */
export function DemoBadge({ floating = false }: { floating?: boolean }) {
  // Read after mount: the demo switch lives in a browser cookie the server render cannot see here.
  const [on, setOn] = useState(false);
  useEffect(() => setOn(demoInBrowser()), []);
  if (!on) return null;
  return <span className={`demoBadge ${floating ? 'demoRibbon' : ''}`} title="Synthetic portfolio. Nothing here is real client data and nothing is sent to FactorCloud."><i />Demo data</span>;
}
