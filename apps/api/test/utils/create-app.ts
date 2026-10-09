import { ModuleMetadata, Provider } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '@src/app.module';
import { configureApp } from '@src/app.setup';

export interface TestAppOptions {
	/** Extra modules to load next to AppModule (e.g. a test-only gateway). */
	imports?: ModuleMetadata['imports'];
	providers?: Provider[];
	/** Replace a provider, e.g. inject a mock LLM: [{ provide: TOKEN, useValue: mock }] */
	overrides?: { provide: unknown; useValue: unknown }[];
}

/**
 * Boots the real AppModule with the same pipeline as main.ts and listens on a
 * random free port, so both Supertest and real socket clients can connect.
 */
export async function createTestApp(
	options: TestAppOptions = {},
): Promise<NestExpressApplication> {
	let builder = Test.createTestingModule({
		imports: [AppModule, ...(options.imports ?? [])],
		providers: options.providers ?? [],
	});
	for (const o of options.overrides ?? []) {
		builder = builder.overrideProvider(o.provide).useValue(o.useValue);
	}
	const moduleRef = await builder.compile();
	const app = moduleRef.createNestApplication<NestExpressApplication>({
		bodyParser: false,
		logger: false,
	});
	configureApp(app);
	await app.listen(0);
	return app;
}

/** Base URL of a listening test app, e.g. http://127.0.0.1:53211 */
export function appUrl(app: NestExpressApplication): string {
	const address = app.getHttpServer().address();
	if (!address || typeof address === 'string') {
		throw new Error('Test app is not listening on a TCP port');
	}
	return `http://127.0.0.1:${address.port}`;
}
