// Writes the API's OpenAPI document to a file, without a database or a port:
//   node dist/scripts/export-openapi.js <out.json>
// The web app turns it into TypeScript types (npm run gen:api).
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@src/app.module';
import { buildOpenApiDocument } from '@src/app.setup';

async function main() {
	const out = process.argv[2];
	if (!out) throw new Error('Usage: export-openapi <out.json>');
	// Preview mode builds the module graph without creating providers, so nothing connects anywhere.
	const app = await NestFactory.create(AppModule, {
		preview: true,
		logger: false,
	});
	writeFileSync(
		resolve(out),
		`${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`,
	);
	await app.close();
	console.log(`OpenAPI document written to ${out}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
