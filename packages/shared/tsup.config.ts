import { defineConfig } from 'tsup';

// Builds both module formats: the API compiles to CommonJS, the web app uses ESM.
// The watcher doesn't clean: `npm run dev` builds first, and wiping dist while
// the API compiles leaves it with missing types until the next API change.
export default defineConfig((options) => ({
	entry: ['src/index.ts'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: !options.watch,
	sourcemap: true,
}));
