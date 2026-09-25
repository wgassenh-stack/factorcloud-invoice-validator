import 'server-only';

import { Pool, type QueryResultRow } from 'pg';

type GlobalWithPool = typeof globalThis & { __factorCloudPortalPool?: Pool };

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured.');
  return url;
}

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function pool(): Pool {
  const globalForPool = globalThis as GlobalWithPool;
  if (!globalForPool.__factorCloudPortalPool) {
    globalForPool.__factorCloudPortalPool = new Pool({
      connectionString: databaseUrl(),
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
    });
  }
  return globalForPool.__factorCloudPortalPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await pool().query<T>(text, values);
  return result.rows;
}
