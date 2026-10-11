import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { E2EContext, setupE2E } from './utils/setup';

// Runs before the app's modules are imported, so configs/env-vars.ts sees it.
vi.hoisted(() => {
	process.env.ACCESS_TOKEN_TTL = '1s';
});

/**
 * The flow the web app relies on: an access token expires, the request gets
 * 401, the refresh token gets a new pair, and the retry succeeds.
 */
describe('Access token lifetime (ACCESS_TOKEN_TTL)', () => {
	let ctx: E2EContext<'maya'>;

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya'] });
	});
	afterAll(async () => {
		await ctx.close();
		// Test files share process.env; don't shorten tokens for the files after this one.
		delete process.env.ACCESS_TOKEN_TTL;
	});

	it('expires after the configured time, and the refresh token gets a working new pair', async () => {
		const { token, refreshToken } = ctx.users.maya;
		const me = () => ctx.http.get('/users/me').set('Authorization', `Bearer ${token}`);
		await me().expect(200);

		await new Promise((r) => setTimeout(r, 2100));
		await me().expect(401);

		const refreshed = await ctx.http
			.get('/auth/refresh-token')
			.set('Authorization', `Bearer ${refreshToken}`)
			.expect(200);
		expect(refreshed.body).toEqual({
			access_token: expect.any(String),
			refresh_token: expect.any(String),
		});
		await ctx.http
			.get('/users/me')
			.set('Authorization', `Bearer ${refreshed.body.access_token}`)
			.expect(200);
		// The new refresh token works too, so a user who keeps the app open stays logged in.
		await ctx.http
			.get('/auth/refresh-token')
			.set('Authorization', `Bearer ${refreshed.body.refresh_token}`)
			.expect(200);
	});
});
