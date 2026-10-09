import 'dotenv/config';

/**
 * e2e tests never touch the dev database. Use TEST_DATABASE_URL if set,
 * otherwise the dev URL with "_test" appended to the database name.
 */
export function testDatabaseUrl(): string {
	if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
	const devUrl = process.env.DATABASE_URL;
	if (!devUrl) {
		throw new Error(
			'DATABASE_URL is not set. Copy .env.example to .env first.',
		);
	}
	const url = new URL(devUrl);
	if (!url.pathname.endsWith('_test')) url.pathname = `${url.pathname}_test`;
	return url.toString();
}
