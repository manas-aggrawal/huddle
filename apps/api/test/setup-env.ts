import 'dotenv/config';

// e2e tests never touch the dev database. Use TEST_DATABASE_URL if set,
// otherwise the dev URL with "_test" appended to the database name.
const devUrl = process.env.DATABASE_URL;
if (!devUrl) {
	throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
}
const url = new URL(devUrl);
url.pathname = `${url.pathname}_test`;
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? url.toString();
