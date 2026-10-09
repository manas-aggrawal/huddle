import { defineConfig } from 'tsup';

// Builds both module formats: the API compiles to CommonJS, the web app uses ESM.
export default defineConfig({
	entry: ['src/index.ts'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: true,
});
