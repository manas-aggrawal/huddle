import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { authed, registerAndLogin, TestUser } from './auth';
import { createTestApp, TestAppOptions } from './create-app';

export interface E2EContext<N extends string> {
	app: NestExpressApplication;
	/** Unauthenticated Supertest client. */
	http: ReturnType<typeof request>;
	/** Registered users by the names you asked for, with their tokens. */
	users: Record<N, TestUser>;
	/** Supertest client acting as one of the users: `as('maya').get('/users/me')` */
	as: (name: N) => ReturnType<typeof authed>;
	close: () => Promise<void>;
}

/**
 * One call to get a running app and logged-in users:
 *
 *   const ctx = await setupE2E({ users: ['maya', 'leo'] });
 *   await ctx.as('maya').get('/users/me').expect(200);
 *   await ctx.close();
 *
 * The database is emptied before each test file (see test/setup-db.ts).
 */
export async function setupE2E<const N extends string = never>(
	options: TestAppOptions & { users?: readonly N[] } = {},
): Promise<E2EContext<N>> {
	const app = await createTestApp(options);
	const users = {} as Record<N, TestUser>;
	for (const name of options.users ?? []) {
		users[name] = await registerAndLogin(app, name);
	}
	return {
		app,
		http: request(app.getHttpServer()),
		users,
		as: (name) => authed(app, users[name].token),
		close: () => app.close(),
	};
}
