// Runs in every test file, before any app code is imported.
import { testDatabaseUrl } from './utils/test-db';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
// DOC_EDITED events wait for the section title to settle; keep that short in tests.
process.env.DOC_EDITED_SETTLE_MS = '150';
// The agent stays off unless a suite turns it on (see test/utils/agent.ts).
process.env.AGENT_ENABLED = 'false';
