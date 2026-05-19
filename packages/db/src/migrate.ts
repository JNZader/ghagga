/**
 * Database migration script.
 *
 * Runs Drizzle migrations + custom SQL (tsvector) in order.
 * Usage: DATABASE_URL=... tsx src/migrate.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('❌ DATABASE_URL is required');
    process.exit(1);
  }

  console.log('🔄 Running Drizzle migrations...');

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);

  // Step 1: Run Drizzle-managed migrations
  await migrate(db, {
    migrationsFolder: join(__dirname, '..', 'drizzle'),
  });

  console.log('✅ Drizzle migrations complete');

  // Step 2: Run custom SQL (tsvector, triggers)
  // The file is idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF EXISTS),
  // so any error here is a real failure and MUST surface — do not swallow.
  const customSqlPath = join(__dirname, '..', 'drizzle', '_custom_tsvector.sql');
  const customSql = readFileSync(customSqlPath, 'utf-8');
  console.log('🔄 Running custom SQL (tsvector + triggers)...');
  await pool.query(customSql);
  console.log('✅ Custom SQL complete');

  await pool.end();
  console.log('🎉 Database ready');
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
