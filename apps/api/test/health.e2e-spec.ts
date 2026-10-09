import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-app';

describe('GET /health', () => {
	let app: NestExpressApplication;

	beforeAll(async () => {
		app = await createTestApp();
	});
	afterAll(async () => {
		await app.close();
	});

	it('reports the database as up, without needing internet access', async () => {
		const res = await request(app.getHttpServer()).get('/health').expect(200);
		expect(res.body).toEqual({
			status: 'ok',
			details: { db: { status: 'up' } },
		});
	});
});
