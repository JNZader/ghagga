/**
 * Vault migration script: rewrite all v1 encrypted API keys to v2 format.
 *
 * v1: base64(iv[12] + ciphertext + authTag[16])
 * v2: "v2:<base64iv>:<base64cipher>:<base64authtag>"
 *
 * Usage:
 *   ENCRYPTION_KEY=<64hex> DATABASE_URL=<pg-url> pnpm --filter ghagga-db migrate:vault
 *
 * Safe to run multiple times — v2 rows are skipped automatically.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq, isNotNull, sql } from 'drizzle-orm';
import { installations } from './schema.js';
import { migrateToV2 } from './crypto.js';

async function main() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error('DATABASE_URL environment variable is not set');
		process.exit(1);
	}

	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	const db = drizzle(client);

	console.log('Fetching installations with encrypted API keys...');

	const rows = await db
		.select({ id: installations.id, encryptedApiKey: installations.encryptedApiKey })
		.from(installations)
		.where(isNotNull(installations.encryptedApiKey));

	console.log(`Found ${rows.length} rows with encrypted API keys.`);

	let migrated = 0;
	let skipped = 0;
	let errors = 0;

	for (const row of rows) {
		if (!row.encryptedApiKey) continue;

		if (row.encryptedApiKey.startsWith('v2:')) {
			skipped++;
			continue;
		}

		try {
			const v2value = migrateToV2(row.encryptedApiKey);
			await db
				.update(installations)
				.set({ encryptedApiKey: v2value })
				.where(eq(installations.id, row.id));
			migrated++;
		} catch (err) {
			console.error(`  ERROR migrating installation ${row.id}:`, err);
			errors++;
		}
	}

	console.log(`\nMigration complete:`);
	console.log(`  Migrated : ${migrated}`);
	console.log(`  Skipped  : ${skipped} (already v2)`);
	console.log(`  Errors   : ${errors}`);

	await client.end();

	if (errors > 0) process.exit(1);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
