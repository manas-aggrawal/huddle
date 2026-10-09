import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaService } from '@src/prisma/prisma.service';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './utils/create-app';

const PASSWORD = 'Str0ng!pass';
const run = Date.now().toString(36);

function newUser(tag: string) {
	return {
		username: `t${run}${tag}`,
		email: `t${run}${tag}@huddle.test`,
		password: PASSWORD,
		firstname: 'Test',
		lastname: 'User',
	};
}

describe('Auth flows', () => {
	let app: NestExpressApplication;
	let http: ReturnType<typeof request>;

	beforeAll(async () => {
		app = await createTestApp();
		http = request(app.getHttpServer());
	});

	afterAll(async () => {
		await app
			.get(PrismaService)
			.user.deleteMany({ where: { username: { startsWith: `t${run}` } } });
		await app.close();
	});

	it('register → login → GET /users/me returns the user', async () => {
		const user = newUser('a');
		const reg = await http.post('/users/register').send(user).expect(200);
		expect(reg.body.access_token).toEqual(expect.any(String));
		expect(reg.body.role).toBe('STANDARD');

		const login = await http
			.post('/users/login')
			.send({ usernameOrEmail: user.email, password: PASSWORD })
			.expect(200);
		expect(login.body.password).toBeUndefined();

		const me = await http
			.get('/users/me')
			.set('Authorization', `Bearer ${login.body.access_token}`)
			.expect(200);
		expect(me.body).toMatchObject({
			username: user.username,
			email: user.email,
			role: 'STANDARD',
		});
		expect(me.body.password).toBeUndefined();
	});

	it('GET /users/me without a token returns 401', async () => {
		await http.get('/users/me').expect(401);
	});

	it('refresh token returns a new access token that works', async () => {
		const reg = await http
			.post('/users/register')
			.send(newUser('b'))
			.expect(200);

		const refreshed = await http
			.get('/auth/refresh-token')
			.set('Authorization', `Bearer ${reg.body.refresh_token}`)
			.expect(200);
		expect(refreshed.body.access_token).toEqual(expect.any(String));

		const me = await http
			.get('/users/me')
			.set('Authorization', `Bearer ${refreshed.body.access_token}`)
			.expect(200);
		expect(me.body.id).toBe(reg.body.id);
	});

	it('an access token is rejected as a refresh token', async () => {
		const reg = await http
			.post('/users/register')
			.send(newUser('c'))
			.expect(200);
		await http
			.get('/auth/refresh-token')
			.set('Authorization', `Bearer ${reg.body.access_token}`)
			.expect(401);
	});

	it('registering a taken username returns 409', async () => {
		const user = newUser('d');
		await http.post('/users/register').send(user).expect(200);
		await http
			.post('/users/register')
			.send({ ...user, email: `other${user.email}` })
			.expect(409);
	});

	it('register ignores a client-supplied role', async () => {
		const reg = await http
			.post('/users/register')
			.send({ ...newUser('e'), role: 'ADMIN' })
			.expect(200);
		expect(reg.body.role).toBe('STANDARD');
	});

	it('register without a last name returns 400, not 500', async () => {
		const { lastname: _omit, ...user } = newUser('f');
		await http.post('/users/register').send(user).expect(400);
	});

	it('a JSON body over 100 KB (but under 10 MB) is accepted by the parser', async () => {
		// Fails validation (400), but must not be rejected as too large (413).
		const res = await http
			.post('/users/register')
			.send({ ...newUser('g'), firstname: 'x'.repeat(200_000) });
		expect(res.status).toBe(400);
	});
});
