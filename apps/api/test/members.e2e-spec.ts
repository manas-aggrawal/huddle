import { SessionRole } from '@huddle/shared';
import { Controller, Module, Post } from '@nestjs/common';
import { RequireSessionAction } from '@src/session/decorators/session-access.decorator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

/**
 * Test-only route guarded by an Editor-level action. No real Editor-only endpoint
 * exists until #15 (messages), so this checks role changes through the real guard.
 */
@Controller('test-only/sessions/:id')
class EditorActionController {
	@Post('suggest')
	@RequireSessionAction('suggest')
	suggest() {
		return { ok: true };
	}
}
@Module({ controllers: [EditorActionController] })
class EditorActionModule {}

describe('Member management', () => {
	let ctx: E2EContext<'maya' | 'leo' | 'dana'>;

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo', 'dana'],
			imports: [EditorActionModule],
		});
	});
	afterAll(async () => {
		await ctx.close();
	});

	/** Maya (Owner) with Leo as Editor and Dana as Viewer, joined through real links. */
	async function team() {
		const s = (
			await ctx
				.as('maya')
				.post('/sessions')
				.send({ title: 'Competitive analysis', goal: 'Compare note apps' })
				.expect(201)
		).body.id as string;
		for (const [name, role] of [
			['leo', 'EDITOR'],
			['dana', 'VIEWER'],
		] as const) {
			const invite = await ctx
				.as('maya')
				.post(`/sessions/${s}/invites`)
				.send({ role })
				.expect(201);
			await ctx
				.as(name)
				.post(`/invites/${invite.body.token}/accept`)
				.expect(200);
		}
		return s;
	}

	const patch = (
		s: string,
		userId: string,
		body: object,
		as: 'maya' | 'leo' | 'dana' = 'maya',
	) => ctx.as(as).patch(`/sessions/${s}/members/${userId}`).send(body);

	it('after the Owner makes Leo a Viewer, Leo gets 403 on an Editor action', async () => {
		const s = await team();
		const suggest = () =>
			ctx.as('leo').post(`/test-only/sessions/${s}/suggest`);
		await suggest().expect(201);

		const res = await patch(s, ctx.users.leo.id, { role: 'VIEWER' }).expect(
			200,
		);
		expect(res.body).toMatchObject({ role: 'VIEWER', canApprove: false });
		await suggest().expect(403);
		// Viewers can still watch.
		await ctx.as('leo').get(`/sessions/${s}`).expect(200);

		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: s, type: 'ROLE_CHANGED', actorId: ctx.users.maya.id },
		});
		expect(event.payload).toMatchObject({
			actor: { name: 'maya Tester' },
			member: { name: 'leo Tester' },
			from: { role: 'EDITOR', canApprove: false },
			to: { role: 'VIEWER', canApprove: false },
		});
	});

	it('toggles approval for an Editor, and turns it off when they become a Viewer', async () => {
		const s = await team();
		await patch(s, ctx.users.leo.id, { canApprove: true }).expect(200);
		let leo = await ctx.as('leo').get(`/sessions/${s}`).expect(200);
		expect(leo.body.myCanApprove).toBe(true);

		await patch(s, ctx.users.leo.id, { role: 'VIEWER' }).expect(200);
		leo = await ctx.as('leo').get(`/sessions/${s}`).expect(200);
		expect(leo.body).toMatchObject({ myRole: 'VIEWER', myCanApprove: false });
	});

	it('rejects approval for a Viewer (400)', async () => {
		const s = await team();
		await patch(s, ctx.users.dana.id, { canApprove: true }).expect(400);
		await patch(s, ctx.users.leo.id, {
			role: 'VIEWER',
			canApprove: true,
		}).expect(400);
	});

	it('rejects making someone Owner, changing the Owner, and an empty change (400)', async () => {
		const s = await team();
		await patch(s, ctx.users.leo.id, { role: 'OWNER' }).expect(400);
		await patch(s, ctx.users.maya.id, { role: 'EDITOR' }).expect(400);
		await patch(s, ctx.users.leo.id, {}).expect(400);
	});

	it('a change that changes nothing writes no event', async () => {
		const s = await team();
		const before = await testPrisma.timelineEvent.count({
			where: { sessionId: s },
		});
		await patch(s, ctx.users.leo.id, { role: 'EDITOR' }).expect(200);
		expect(
			await testPrisma.timelineEvent.count({ where: { sessionId: s } }),
		).toBe(before);
	});

	it('removing Dana cuts her access at once and writes MEMBER_REMOVED', async () => {
		const s = await team();
		await ctx.as('dana').get(`/sessions/${s}`).expect(200);
		await ctx
			.as('maya')
			.delete(`/sessions/${s}/members/${ctx.users.dana.id}`)
			.expect(204);
		await ctx.as('dana').get(`/sessions/${s}`).expect(404);

		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: s, type: 'MEMBER_REMOVED' },
		});
		expect(event.payload).toMatchObject({
			actor: { name: 'maya Tester' },
			member: { name: 'dana Tester' },
			role: 'VIEWER',
		});
	});

	it('the Owner cannot remove themselves (400); an unknown member is 404', async () => {
		const s = await team();
		await ctx
			.as('maya')
			.delete(`/sessions/${s}/members/${ctx.users.maya.id}`)
			.expect(400);
		await ctx
			.as('maya')
			.delete(`/sessions/${s}/members/00000000-0000-0000-0000-000000000000`)
			.expect(404);
		expect(
			await testPrisma.sessionMember.count({
				where: { sessionId: s, role: SessionRole.OWNER },
			}),
		).toBe(1);
	});

	it('Editors and Viewers cannot change roles or remove members (403)', async () => {
		const s = await team();
		await patch(s, ctx.users.dana.id, { role: 'EDITOR' }, 'leo').expect(403);
		await patch(s, ctx.users.leo.id, { role: 'VIEWER' }, 'dana').expect(403);
		await ctx
			.as('leo')
			.delete(`/sessions/${s}/members/${ctx.users.dana.id}`)
			.expect(403);
		await ctx
			.as('dana')
			.delete(`/sessions/${s}/members/${ctx.users.leo.id}`)
			.expect(403);
	});
});
