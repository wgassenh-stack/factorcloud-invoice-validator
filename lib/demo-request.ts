import { cookies } from 'next/headers';
import { DEMO_COOKIE, demoFromCookie, demoMode } from './demo';

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
