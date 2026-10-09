import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(
	base,
	defineConfig({
		test: {
			include: ['test/**/*.e2e-spec.ts'],
			// Once per run: create and migrate the test database.
			globalSetup: ['test/global-setup.ts'],
			// Per file: point at the test DB, then empty every table.
			setupFiles: ['test/setup-env.ts', 'test/setup-db.ts'],
			// All e2e files share one test database, so run them one at a time.
			fileParallelism: false,
			testTimeout: 20_000,
			hookTimeout: 30_000,
		},
	}),
);
