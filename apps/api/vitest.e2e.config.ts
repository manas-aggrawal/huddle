import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(
	base,
	defineConfig({
		test: {
			include: ['test/**/*.e2e-spec.ts'],
			setupFiles: ['test/setup-env.ts'],
			// All e2e files share one test database, so run them one at a time.
			fileParallelism: false,
			testTimeout: 20_000,
			hookTimeout: 30_000,
		},
	}),
);
