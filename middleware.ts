import { NextResponse, type NextRequest } from 'next/server';
import { DEMO_COOKIE, adminViewsEnabled, demoFromCookie, demoMode } from './lib/demo';
import { databaseAuthEnabled, PORTAL_SESSION_COOKIE, verifyPortalSession } from './lib/session';

export async function middleware(req: NextRequest) {
  // This route validates its own dedicated worker secret before doing anything.
  if (req.nextUrl.pathname === '/api/internal/notifications') return NextResponse.next();
  // Demo mode holds no real data, so client and factor pages are both open (behind the shared
  // password when one is set).
  if (demoMode()) return passwordGate(req);
  if (databaseAuthEnabled()) return databaseAuth(req);
  return pilotAuth(req, demoFromCookie(req.cookies.get(DEMO_COOKIE)?.value));
}

async function databaseAuth(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const publicPath = path === '/login' || path === '/api/portal-auth/login' || path === '/invite' || path === '/api/portal-auth/accept-invite';
  const session = await verifyPortalSession(req.cookies.get(PORTAL_SESSION_COOKIE)?.value);

  if (publicPath) {
    if (session && path === '/login') {
      return NextResponse.redirect(new URL(session.role === 'DRIVER' ? '/driver' : session.role === 'CLIENT_USER' ? '/' : '/ops', req.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    const login = new URL('/login', req.url);
    login.searchParams.set('next', path + req.nextUrl.search);
    return NextResponse.redirect(login);
  }

  if (session.role === 'DRIVER' && !driverPath(path)) {
    if (path.startsWith('/api/')) return NextResponse.json({error:'Driver access is limited to your paperwork.'},{status:403});
    return NextResponse.redirect(new URL('/driver',req.url));
  }

  if (isOpsPath(path) && session.role === 'CLIENT_USER') {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'Factor access required.' }, { status: 403 });
    return NextResponse.redirect(new URL('/', req.url));
  }

  return NextResponse.next();
}

function driverPath(path: string) {
  return ['/driver','/submit','/api/driver/invoices','/api/create','/api/portal-auth/session','/api/portal-auth/logout'].includes(path) || path.startsWith('/api/paperwork/') || path.startsWith('/api/tasks/');
}

function pilotAuth(req: NextRequest, demo: boolean) {
  // Factor operations show every client's data, so they need per-user roles. Without database
  // authentication they are switched off entirely rather than left open to the shared password.
  // A browser in demo mode may open them: every ops API answers demo requests with fake data only.
  // With NEXT_PUBLIC_ADMIN_VIEWS=true (test environments) the password holder is the factor's admin.
  if (isOpsPath(req.nextUrl.pathname) && !demo && !adminViewsEnabled()) {
    return NextResponse.json({ error: 'Factor operations require database authentication.' }, { status: 404 });
  }
  return passwordGate(req);
}

function passwordGate(req: NextRequest) {
  const password = process.env.APP_ACCESS_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === 'production') return new NextResponse('APP_ACCESS_PASSWORD is not configured.', { status: 503 });
    return NextResponse.next();
  }
  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      const supplied = decoded.slice(decoded.indexOf(':') + 1);
      if (timingSafeEqual(supplied, password)) return NextResponse.next();
    } catch { /* challenge below */ }
  }
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Invoice Validator", charset="UTF-8"' },
  });
}

function isOpsPath(path: string): boolean {
  return path === '/ops' || path.startsWith('/ops/') || path === '/api/ops' || path.startsWith('/api/ops/');
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };

