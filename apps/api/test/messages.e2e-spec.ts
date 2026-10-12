import { EventType, SessionRole } from '@huddle/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

describe('Messages API', () => {
	let ctx: E2EContext<'maya' | 'leo' | 'dana'>;
	let sessionId: string;

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo', 'dana'] });
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Note apps', goal: 'Compare note apps' })
			.expect(201);
		sessionId = res.body.id;
		await testPrisma.sessionMember.createMany({
			data: [
				{ sessionId, userId: ctx.users.leo.id, role: SessionRole.EDITOR },
				{ sessionId, userId: ctx.users.dana.id, role: SessionRole.VIEWER },
			],
		});
	});
	afterAll(async () => {
		await ctx.close();
	});

	const post = (who: 'maya' | 'leo' | 'dana', body: object, id = sessionId) =>
		ctx.as(who).post(`/sessions/${id}/messages`).send(body);

	it('an Editor’s Suggest is QUEUED and announced with the author’s name and role', async () => {
		const res = await post('leo', {
			mode: 'SUGGEST',
			content: 'Add UX notes',
		}).expect(201);
		expect(res.body).toMatchObject({
			mode: 'SUGGEST',
			status: 'QUEUED',
			authorId: ctx.users.leo.id,
		});

		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId, type: EventType.HUMAN_MESSAGE },
			orderBy: { seq: 'desc' },
		});
		expect(event.payload).toMatchObject({
			messageId: res.body.id,
			mode: 'SUGGEST',
			content: 'Add UX notes',
			author: { id: ctx.users.leo.id, name: 'leo Tester', role: 'EDITOR' },
		});
	});

	it('a Viewer can Ask but not Suggest or Interrupt', async () => {
		await post('dana', { mode: 'SUGGEST', content: 'x' }).expect(403);
		await post('dana', { mode: 'INTERRUPT', content: 'x' }).expect(403);
		await post('dana', { mode: 'ASK', content: 'Why Notion first?' }).expect(
			201,
		);
	});

	it('an Editor can Interrupt', async () => {
		await post('leo', { mode: 'INTERRUPT', content: 'Stop' }).expect(201);
	});

	it('mentioning @[leoId] notifies Leo, and only members get notified', async () => {
		const res = await post('maya', {
			mode: 'SUGGEST',
			content: `@[${ctx.users.leo.id}] can you check pricing? cc @[00000000-0000-4000-8000-000000000000]`,
		}).expect(201);
		const notes = await testPrisma.notification.findMany({
			where: { refId: res.body.id },
		});
		expect(notes).toEqual([
			expect.objectContaining({
				userId: ctx.users.leo.id,
				type: 'MENTION',
				title: 'maya Tester mentioned you',
			}),
		]);
	});

	it('rejects empty and over-long content', async () => {
		await post('leo', { mode: 'SUGGEST', content: '   ' }).expect(400);
		await post('leo', { mode: 'SUGGEST', content: 'x'.repeat(4001) }).expect(
			400,
		);
		await post('leo', { mode: 'SHOUT', content: 'hi' }).expect(400);
	});

	it('a comment needs an anchor; a Viewer can comment', async () => {
		await post('dana', {
			mode: 'COMMENT',
			content: 'Be more skeptical',
		}).expect(400);
		const res = await post('dana', {
			mode: 'COMMENT',
			content: 'Be more skeptical',
			anchor: { sectionId: 'sec_1', quote: 'Notion is the best' },
		}).expect(201);
		const saved = await testPrisma.message.findUniqueOrThrow({
			where: { id: res.body.id },
		});
		expect(saved.anchor).toEqual({
			sectionId: 'sec_1',
			quote: 'Notion is the best',
		});
	});

	it('a done session refuses instructions but still takes questions', async () => {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Done one', goal: 'g' })
			.expect(201);
		await ctx
			.as('maya')
			.patch(`/sessions/${res.body.id}/status`)
			.send({ action: 'end' })
			.expect(200);
		await post(
			'maya',
			{ mode: 'SUGGEST', content: 'more' },
			res.body.id,
		).expect(409);
		await post('maya', { mode: 'ASK', content: 'why?' }, res.body.id).expect(
			201,
		);
	});

	it('outsiders get 404', async () => {
		const other = await ctx
			.as('leo')
			.post('/sessions')
			.send({ title: 'Leo’s', goal: 'g' })
			.expect(201);
		await post('dana', { mode: 'ASK', content: 'hi' }, other.body.id).expect(
			404,
		);
	});
});
