import { Pool } from 'pg';

let pool: Pool | undefined;

export function getDbPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      console.warn('DATABASE_URL is not set in environment variables');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }
  return pool;
}

export async function query(text: string, params?: any[]) {
  const p = getDbPool();
  const res = await p.query(text, params);
  return res;
}
