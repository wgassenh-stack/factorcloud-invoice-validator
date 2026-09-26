// Demo mode: the whole portal runs on a synthetic portfolio so it can be shown without a
// FactorCloud connection, a database or real client data. Off unless NEXT_PUBLIC_DEMO_MODE=true.
// In demo mode nothing is sent to FactorCloud and nothing is written to the database; every
// page carries a "Demo data" badge so the numbers are never mistaken for a real portfolio.
//
// Safe to import from middleware, server and client code (no Node-only dependencies).

export function demoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

/** The FactorCloud client this portal belongs to, in demo mode. */
export const DEMO_CLIENT_ID = 'demo-client-01';
export const DEMO_FACTOR_ID = 'demo-factor';
