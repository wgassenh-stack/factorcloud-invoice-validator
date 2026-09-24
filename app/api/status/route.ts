import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { TOKEN_COOKIE } from '@/lib/factorcloud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which pieces of configuration are present, so the UI can explain what's missing. */
export async function GET() {
  const jar = await cookies();
  const session = Boolean(jar.get(TOKEN_COOKIE)?.value);
  const envToken = Boolean(process.env.FACTORCLOUD_BEARER_TOKEN);
  return NextResponse.json({
    factorCloud: {
      signedIn: session || envToken,
      source: session ? 'session' : envToken ? 'env' : null,
      canSignIn: Boolean(process.env.FACTORCLOUD_USERNAME && process.env.FACTORCLOUD_PASSWORD),
      factorId: Boolean(process.env.FACTORCLOUD_FACTOR_ID),
      clientId: Boolean(process.env.FACTORCLOUD_CLIENT_ID),
      debtorCount: (process.env.FACTORCLOUD_DEBTOR_IDS ?? '').split(',').filter((s) => s.trim()).length,
    },
    ai: Boolean(process.env.ANTHROPIC_API_KEY || process.env.AI_API_KEY),
  });
}
