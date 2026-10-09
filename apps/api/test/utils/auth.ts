import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

export const TEST_PASSWORD = 'Str0ng!pass';

export interface TestUser {
	id: string;
	username: string;
	email: string;
	password: string;
	token: string;
	refreshToken: string;
}

/**
 * Registers a user through the real API and returns their tokens.
 * `name` becomes the username (lowercased, letters and digits, padded to the 5-char minimum).
 */
export async function registerAndLogin(
	app: NestExpressApplication,
	name: string,
): Promise<TestUser> {
	const username = name
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '')
		.padEnd(5, '0');
	const email = `${username}@huddle.test`;
	const res = await request(app.getHttpServer())
		.post('/users/register')
		.send({
			username,
			email,
			password: TEST_PASSWORD,
			firstname: name.slice(0, 50).padEnd(2, 'x'),
			lastname: 'Tester',
		});
	if (res.status !== 200) {
		throw new Error(
			`registerAndLogin(${name}) failed: ${res.status} ${JSON.stringify(res.body)}`,
		);
	}
	return {
		id: res.body.id,
		username,
		email,
		password: TEST_PASSWORD,
		token: res.body.access_token,
		refreshToken: res.body.refresh_token,
	};
}

/** Supertest calls with the user's Bearer token already set. */
export function authed(app: NestExpressApplication, token: string) {
	const server = app.getHttpServer();
	const auth = (t: request.Test) => t.set('Authorization', `Bearer ${token}`);
	return {
		get: (url: string) => auth(request(server).get(url)),
		post: (url: string) => auth(request(server).post(url)),
		put: (url: string) => auth(request(server).put(url)),
		patch: (url: string) => auth(request(server).patch(url)),
		delete: (url: string) => auth(request(server).delete(url)),
	};
}
