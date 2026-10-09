import { PrismaClient } from '@prisma/client';

/** Direct database access for assertions and fixtures, separate from the app's client. */
export const testPrisma = new PrismaClient();

/** Empties every table except Prisma's migration history. */
export async function resetDatabase(): Promise<void> {
	const tables = await testPrisma.$queryRaw<{ tablename: string }[]>`
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
	if (tables.length === 0) return;
	const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
	await testPrisma.$executeRawUnsafe(
		`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
	);
}
