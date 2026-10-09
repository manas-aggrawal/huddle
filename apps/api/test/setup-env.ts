// Runs in every test file, before any app code is imported.
import { testDatabaseUrl } from './utils/test-db';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
