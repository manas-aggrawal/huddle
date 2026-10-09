import { resolve } from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles the TypeScript so Nest's decorator metadata (used for DI) is emitted;
// esbuild, Vitest's default, can't do that.
export default defineConfig({
	plugins: [swc.vite({ module: { type: 'es6' } })],
	resolve: {
		// Mirrors "paths" in tsconfig.json.
		alias: {
			'@src': resolve(__dirname, 'src'),
			'@auth': resolve(__dirname, 'src/auth'),
			'@configs': resolve(__dirname, 'src/configs'),
			'@middleware': resolve(__dirname, 'src/middleware'),
			'@user': resolve(__dirname, 'src/user'),
		},
	},
	test: {
		include: ['src/**/*.spec.ts'],
		passWithNoTests: true,
	},
});
