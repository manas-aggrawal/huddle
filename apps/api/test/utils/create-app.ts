import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '@src/app.module';
import { configureApp } from '@src/app.setup';

/** Boots the real AppModule with the same pipeline as main.ts. */
export async function createTestApp(): Promise<NestExpressApplication> {
	const moduleRef = await Test.createTestingModule({
		imports: [AppModule],
	}).compile();
	const app = moduleRef.createNestApplication<NestExpressApplication>({
		bodyParser: false,
	});
	configureApp(app);
	await app.init();
	return app;
}
