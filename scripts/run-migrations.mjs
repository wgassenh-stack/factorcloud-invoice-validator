import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

try {
  const directory = path.join(process.cwd(), 'database');
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(directory, file), 'utf8');
    console.log(`Running ${file}`);
    await pool.query(sql);
  }
  console.log(`Applied ${files.length} migration file(s).`);
} finally {
  await pool.end();
}
