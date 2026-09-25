import { NextResponse, type NextRequest } from 'next/server';
import { databaseAuthEnabled, PORTAL_SESSION_COOKIE, verifyPortalSession } from './lib/session';

export async function middleware(req: NextRequest) {
  if (databaseAuthEnabled()) return databaseAuth(req);
  return pilotAuth(req);
}

async function databaseAuth(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const publicPath = path === '/login' || path === '/api/portal-auth/login';
  const session = await verifyPortalSession(req.cookies.get(PORTAL_SESSION_COOKIE)?.value);

  if (publicPath) {
    if (session && path === '/login') {
      return NextResponse.redirect(new URL(session.role === 'CLIENT_USER' ? '/' : '/ops', req.url));
    }
    return NextResponse.next();
  }

  if (!session) {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    const login = new URL('/login', req.url);
    login.searchParams.set('next', path + req.nextUrl.search);
    return NextResponse.redirect(login);
  }

  const isOps = path === '/ops' || path.startsWith('/ops/') || path.startsWith('/api/ops');
  if (isOps && session.role === 'CLIENT_USER') {
    if (path.startsWith('/api/')) return NextResponse.json({ error: 'Factor access required.' }, { status: 403 });
    return NextResponse.redirect(new URL('/', req.url));
  }

  return NextResponse.next();
}

function pilotAuth(req: NextRequest) {
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

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
