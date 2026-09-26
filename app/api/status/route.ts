import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { TOKEN_COOKIE } from '@/lib/factorcloud';
import { demoMode } from '@/lib/demo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (demoMode()) {
    return NextResponse.json({
      demo: true,
      factorCloud: { signedIn: true, source: 'demo', canSignIn: false, factorId: true, clientId: true, debtorCount: 60 },
      ai: { configured: true, model: process.env.GEMINI_API_KEY ? process.env.EXTRACTION_MODEL || 'gemini-3.5-flash-lite' : 'demo-extractor', thinking: 'minimal' },
    });
  }
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
    ai: {
      configured: Boolean(process.env.GEMINI_API_KEY || process.env.AI_API_KEY),
      model: process.env.EXTRACTION_MODEL || 'gemini-3.5-flash-lite',
      thinking: process.env.EXTRACTION_THINKING || 'minimal',
    },
  });
}
