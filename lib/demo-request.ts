import { cookies } from 'next/headers';
import { DEMO_COOKIE, DEMO_VIEW_COOKIE, demoFromCookie, demoMode, demoViewFromCookie, type DemoClientView } from './demo';

/**
 * Whether the current server request is in demo mode: the deployment setting, or this browser's
 * demo switch. Outside a request (scripts, tests) only the deployment setting counts.
 */
export async function demoRequest(): Promise<boolean> {
  if (demoMode()) return true;
  try {
    const jar = await cookies();
    return demoFromCookie(jar.get(DEMO_COOKIE)?.value);
  } catch {
    return false;
  }
}

/** Demo only: whether this browser is on the Manager or the Driver view of the client side. */
export async function demoClientView(): Promise<DemoClientView> {
  try {
    const jar = await cookies();
    return demoViewFromCookie(jar.get(DEMO_VIEW_COOKIE)?.value);
  } catch {
    return 'manager';
  }
}
