// Demo mode: the whole portal runs on a synthetic portfolio so it can be shown without a
// FactorCloud connection, a database or real client data. Nothing is sent to FactorCloud and
// nothing is written to the database; every page carries a "Demo data" badge so the numbers are
// never mistaken for a real portfolio.
//
// Two ways in:
//  - NEXT_PUBLIC_DEMO_MODE=true puts the whole deployment in demo mode.
//  - The in-app "Load demo data" switch sets the DEMO_COOKIE for one browser. Everyone else keeps
//    seeing the real portal. NEXT_PUBLIC_DEMO_TOGGLE=false hides the switch (for client-facing sites).
// The cookie only ever swaps real data for fake data. It never signs anyone in.
//
// Safe to import from middleware, server and client code (no Node-only dependencies).

export const DEMO_COOKIE = 'fc_demo';

/** The whole deployment is in demo mode. */
export function demoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

/** Whether the per-browser demo switch is offered. */
export function demoToggleEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_TOGGLE !== 'false';
}

/** Demo mode for a request, given the value of its demo cookie. */
export function demoFromCookie(cookieValue: string | undefined | null): boolean {
  return demoMode() || (demoToggleEnabled() && cookieValue === '1');
}

/** Browser only: whether this browser is in demo mode. */
export function demoInBrowser(): boolean {
  if (typeof document === 'undefined') return demoMode();
  const value = document.cookie.split('; ').find((part) => part.startsWith(`${DEMO_COOKIE}=`))?.split('=')[1];
  return demoFromCookie(value);
}

/** The FactorCloud client this portal belongs to, in demo mode. */
export const DEMO_CLIENT_ID = 'demo-client-01';
export const DEMO_FACTOR_ID = 'demo-factor';

// Demo only: the client side can be viewed as the company's manager or as one of its drivers.
// Like the demo cookie, this only changes what is shown; it grants nothing.
export const DEMO_VIEW_COOKIE = 'fc_view';
export type DemoClientView = 'manager' | 'driver';
/** The driver the demo's Driver view shows. */
export const DEMO_DRIVER = 'Marcus Reed';
/** Everyone who sends in paperwork for the demo client. */
export const DEMO_DRIVERS = [DEMO_DRIVER, 'Dana Ortiz', 'Tyrell Banks', 'Ann Kowalski'] as const;

export function demoViewFromCookie(value: string | undefined | null): DemoClientView {
  return value === 'driver' ? 'driver' : 'manager';
}

/** Browser only: which client view this browser is on. */
export function demoViewInBrowser(): DemoClientView {
  if (typeof document === 'undefined') return 'manager';
  return demoViewFromCookie(document.cookie.split('; ').find((part) => part.startsWith(`${DEMO_VIEW_COOKIE}=`))?.split('=')[1]);
}

export function setDemoViewInBrowser(view: DemoClientView): void {
  document.cookie = `${DEMO_VIEW_COOKIE}=${view}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
}

// Shared-password (pilot) deployments only, for test environments: NEXT_PUBLIC_ADMIN_VIEWS=true
// treats whoever holds the site password as the factor's admin, who can switch between the
// Manager, Driver and Factor views on real data. Ignored with database sign-in, where roles decide.
export function adminViewsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ADMIN_VIEWS === 'true';
}

/** Browser only: whether this browser is showing the Driver view (demo data or admin views). */
export function driverViewInBrowser(): boolean {
  return (demoInBrowser() || adminViewsEnabled()) && demoViewInBrowser() === 'driver';
}
