// Runs in every test file: each file starts with empty tables, so files never
// depend on each other's data or on run order.
import { afterAll, beforeAll } from 'vitest';
import { resetDatabase, testPrisma } from './utils/db';

beforeAll(async () => {
	await resetDatabase();
});

afterAll(async () => {
	await testPrisma.$disconnect();
});
