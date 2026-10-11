import { hashToken } from '@src/invite/invite.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

describe('Invites', () => {
	let ctx: E2EContext<'maya' | 'leo' | 'dana'>;

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo', 'dana'] });
	});
	afterAll(async () => {
		await ctx.close();
	});

	async function mayaSession() {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Competitive analysis', goal: 'Compare note apps' })
			.expect(201);
		return res.body.id as string;
	}

	async function link(
		sessionId: string,
		role: 'EDITOR' | 'VIEWER',
		expiresInHours?: number,
	) {
		const res = await ctx
			.as('maya')
			.post(`/sessions/${sessionId}/invites`)
			.send({ role, ...(expiresInHours ? { expiresInHours } : {}) })
			.expect(201);
		return res.body as { id: string; token: string; url: string };
	}

	const accept = (name: 'leo' | 'dana', token: string) =>
		ctx.as(name).post(`/invites/${token}/accept`);

	const memberOf = (sessionId: string, userId: string) =>
		testPrisma.sessionMember.findUnique({
			where: { sessionId_userId: { sessionId, userId } },
		});

	it('Owner makes an Editor link; Leo accepts and becomes an Editor, with MEMBER_JOINED', async () => {
		const s = await mayaSession();
		const invite = await link(s, 'EDITOR');
		expect(invite.url).toBe(`http://localhost:5173/invite/${invite.token}`);

		const res = await accept('leo', invite.token).expect(200);
		expect(res.body).toEqual({
			sessionId: s,
			role: 'EDITOR',
			joined: true,
			upgraded: false,
		});
		expect((await memberOf(s, ctx.users.leo.id))?.role).toBe('EDITOR');

		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: s, type: 'MEMBER_JOINED' },
		});
		expect(event).toMatchObject({
			seq: 2,
			actorId: ctx.users.leo.id,
			payload: {
				actor: { name: 'leo Tester' },
				role: 'EDITOR',
				inviteId: invite.id,
			},
		});
		const row = await testPrisma.invite.findUniqueOrThrow({
			where: { id: invite.id },
		});
		expect(row.useCount).toBe(1);
	});

	it('accepting the same link twice keeps one membership and changes nothing', async () => {
		const s = await mayaSession();
		const invite = await link(s, 'EDITOR');
		await accept('leo', invite.token).expect(200);
		const again = await accept('leo', invite.token).expect(200);
		expect(again.body).toMatchObject({
			joined: false,
			upgraded: false,
			role: 'EDITOR',
		});
		expect(
			await testPrisma.sessionMember.count({ where: { sessionId: s } }),
		).toBe(2);
		expect(
			(await testPrisma.invite.findUniqueOrThrow({ where: { id: invite.id } }))
				.useCount,
		).toBe(1);
	});

	it('never downgrades: an Editor opening a Viewer link stays an Editor; the Owner is untouched', async () => {
		const s = await mayaSession();
		await accept('leo', (await link(s, 'EDITOR')).token).expect(200);
		const share = await link(s, 'VIEWER');

		const res = await accept('leo', share.token).expect(200);
		expect(res.body).toMatchObject({ role: 'EDITOR', upgraded: false });

		await ctx.as('maya').post(`/invites/${share.token}/accept`).expect(200);
		expect((await memberOf(s, ctx.users.maya.id))?.role).toBe('OWNER');
	});

	it('upgrades: a Viewer opening an Editor link becomes an Editor, with ROLE_CHANGED', async () => {
		const s = await mayaSession();
		await accept('dana', (await link(s, 'VIEWER')).token).expect(200);
		const res = await accept('dana', (await link(s, 'EDITOR')).token).expect(
			200,
		);
		expect(res.body).toMatchObject({
			role: 'EDITOR',
			joined: false,
			upgraded: true,
		});

		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: s, type: 'ROLE_CHANGED' },
		});
		expect(event.payload).toMatchObject({
			from: { role: 'VIEWER' },
			to: { role: 'EDITOR' },
			via: 'invite',
		});
	});

	it('the preview works without logging in and shows title, inviter and role', async () => {
		const s = await mayaSession();
		const invite = await link(s, 'VIEWER');
		const res = await ctx.http.get(`/invites/${invite.token}`).expect(200);
		expect(res.body).toEqual({
			sessionId: s,
			sessionTitle: 'Competitive analysis',
			invitedBy: 'maya Tester',
			role: 'VIEWER',
			expiresAt: null,
		});
	});

	it('accepting needs a login', async () => {
		const s = await mayaSession();
		const invite = await link(s, 'EDITOR');
		await ctx.http.post(`/invites/${invite.token}/accept`).expect(401);
	});

	it('expired and revoked links return 410 on preview and accept; unknown tokens 404', async () => {
		const s = await mayaSession();
		const expiring = await link(s, 'EDITOR', 1);
		await testPrisma.invite.update({
			where: { id: expiring.id },
			data: { expiresAt: new Date(Date.now() - 1000) },
		});
		const revoked = await link(s, 'EDITOR');
		await ctx
			.as('maya')
			.delete(`/sessions/${s}/invites/${revoked.id}`)
			.expect(204);

		for (const token of [expiring.token, revoked.token]) {
			await ctx.http.get(`/invites/${token}`).expect(410);
			await accept('leo', token).expect(410);
		}
		const msg = await ctx.http.get(`/invites/${revoked.token}`);
		expect(msg.body.message).toMatch(/revoked/);
		expect(await memberOf(s, ctx.users.leo.id)).toBeNull();

		await ctx.http.get('/invites/made-up-token').expect(404);
	});

	it('stores only a hash of the token, never the token itself', async () => {
		const s = await mayaSession();
		const invite = await link(s, 'EDITOR');
		const row = await testPrisma.invite.findUniqueOrThrow({
			where: { id: invite.id },
		});
		expect(row.token).not.toBe(invite.token);
		expect(row.token).toBe(hashToken(invite.token));
		expect(row.token).toMatch(/^[0-9a-f]{64}$/);
	});

	it('lists only links that still work, without tokens', async () => {
		const s = await mayaSession();
		const keep = await link(s, 'EDITOR');
		const gone = await link(s, 'VIEWER');
		await ctx
			.as('maya')
			.delete(`/sessions/${s}/invites/${gone.id}`)
			.expect(204);

		const res = await ctx.as('maya').get(`/sessions/${s}/invites`).expect(200);
		expect(res.body.map((i: { id: string }) => i.id)).toEqual([keep.id]);
		expect(res.body[0]).not.toHaveProperty('token');
		expect(res.body[0].createdBy.name).toBe('maya Tester');
	});

	it('Editors and Viewers cannot create, list or revoke links (403)', async () => {
		const s = await mayaSession();
		const invite = await link(s, 'EDITOR');
		await accept('leo', invite.token).expect(200);
		await accept('dana', (await link(s, 'VIEWER')).token).expect(200);

		for (const name of ['leo', 'dana'] as const) {
			await ctx
				.as(name)
				.post(`/sessions/${s}/invites`)
				.send({ role: 'VIEWER' })
				.expect(403);
			await ctx.as(name).get(`/sessions/${s}/invites`).expect(403);
			await ctx
				.as(name)
				.delete(`/sessions/${s}/invites/${invite.id}`)
				.expect(403);
		}
	});

	it('rejects an OWNER link and bad expiry values', async () => {
		const s = await mayaSession();
		const post = (body: object) =>
			ctx.as('maya').post(`/sessions/${s}/invites`).send(body);
		await post({ role: 'OWNER' }).expect(400);
		await post({ role: 'EDITOR', expiresInHours: 0 }).expect(400);
		await post({ role: 'EDITOR', expiresInHours: 24 * 31 }).expect(400);
	});

	it('revoking a link from another session is a 404', async () => {
		const a = await mayaSession();
		const b = await mayaSession();
		const inB = await link(b, 'EDITOR');
		await ctx.as('maya').delete(`/sessions/${a}/invites/${inB.id}`).expect(404);
	});
});
