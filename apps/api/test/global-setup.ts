// Runs once before the whole e2e suite: makes sure the test database exists
// and has every migration applied, so a fresh clone needs no manual steps.
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { testDatabaseUrl } from './utils/test-db';

export default async function globalSetup() {
	const url = new URL(testDatabaseUrl());
	const dbName = decodeURIComponent(url.pathname.slice(1));

	// Connect to the server's maintenance database to create the test DB.
	const adminUrl = new URL(url);
	adminUrl.pathname = '/postgres';
	const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
	try {
		const rows = await admin.$queryRaw<{ exists: boolean }[]>`
			SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${dbName}) AS "exists"`;
		if (!rows[0].exists) {
			// Identifiers can't be bound as parameters; dbName comes from our own config.
			await admin.$executeRawUnsafe(
				`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`,
			);
		}
	} finally {
		await admin.$disconnect();
	}

	execSync('npx prisma migrate deploy', {
		cwd: resolve(__dirname, '..'),
		env: { ...process.env, DATABASE_URL: url.toString() },
		stdio: 'pipe',
	});
}
