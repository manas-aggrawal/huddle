import { ApprovalKind, EventType, SessionRole } from '@huddle/shared';
import { ApprovalService } from '@src/approval/approval.service';
import { LLM_PROVIDER_OVERRIDE, type ModelFactory } from '@src/llm/providers';
import { TimelineService } from '@src/timeline/timeline.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { type ScriptedModel, scriptedModel } from './utils/mock-llm';
import { E2EContext, setupE2E } from './utils/setup';

describe('Handoff', () => {
	let ctx: E2EContext<'maya' | 'leo' | 'dana' | 'outsider'>;
	let mock: ScriptedModel = scriptedModel([]);
	const factory: ModelFactory = () => mock.model;

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo', 'dana', 'outsider'],
			overrides: [{ provide: LLM_PROVIDER_OVERRIDE, useValue: factory }],
		});
	});
	afterAll(async () => {
		await ctx.close();
	});

	async function session() {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Handoff', goal: 'Compare note apps' })
			.expect(201);
		const id = res.body.id as string;
		await testPrisma.sessionMember.createMany({
			data: [
				{ sessionId: id, userId: ctx.users.leo.id, role: SessionRole.EDITOR },
				{ sessionId: id, userId: ctx.users.dana.id, role: SessionRole.VIEWER },
			],
		});
		return id;
	}
	const roles = async (id: string) =>
		Object.fromEntries(
			(
				await testPrisma.sessionMember.findMany({ where: { sessionId: id } })
			).map((m) => [m.userId, m.role]),
		);

	it('the preview drafts a briefing from the session; nothing changes yet', async () => {
		const id = await session();
		await testPrisma.planStep.createMany({
			data: [
				{ sessionId: id, position: 1, title: 'Notion', status: 'DONE' },
				{ sessionId: id, position: 2, title: 'Obsidian' },
			],
		});
		await ctx
			.as('maya')
			.post(`/sessions/${id}/decisions`)
			.send({ content: 'Prices in euros' })
			.expect(201);
		mock = scriptedModel([
			{ text: 'Notion is done; Obsidian is next. Prices are in euros.' },
		]);
		const res = await ctx
			.as('maya')
			.post(`/sessions/${id}/handoff/preview`)
			.send({ toUserId: ctx.users.leo.id })
			.expect(200);
		expect(res.body.briefing).toBe(
			'Notion is done; Obsidian is next. Prices are in euros.',
		);
		const prompt = mock.promptText(0);
		expect(prompt).toContain('[done] Notion');
		expect(prompt).toContain('Prices in euros');
		expect(prompt).toContain('leo Tester');
		expect((await roles(id))[ctx.users.maya.id]).toBe(SessionRole.OWNER);
	});

	it('roles swap: the new Owner is OWNER, the old one an Editor, and there is exactly one Owner', async () => {
		const id = await session();
		const res = await ctx
			.as('maya')
			.post(`/sessions/${id}/handoff`)
			.send({
				toUserId: ctx.users.leo.id,
				briefing: 'All yours.',
				note: 'Back Monday',
			})
			.expect(201);
		const r = await roles(id);
		expect(r[ctx.users.leo.id]).toBe(SessionRole.OWNER);
		expect(r[ctx.users.maya.id]).toBe(SessionRole.EDITOR);
		expect(
			Object.values(r).filter((x) => x === SessionRole.OWNER),
		).toHaveLength(1);

		const row = await testPrisma.handoff.findUniqueOrThrow({
			where: { id: res.body.id },
		});
		expect(row).toMatchObject({
			briefing: 'All yours.',
			note: 'Back Monday',
			fromUserId: ctx.users.maya.id,
			toUserId: ctx.users.leo.id,
		});
		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.HANDOFF },
		});
		expect(event.payload).toMatchObject({
			from: { id: ctx.users.maya.id, name: 'maya Tester' },
			to: { id: ctx.users.leo.id, name: 'leo Tester' },
			note: 'Back Monday',
		});
		const note = await testPrisma.notification.findFirstOrThrow({
			where: { refId: res.body.id },
		});
		expect(note).toMatchObject({
			userId: ctx.users.leo.id,
			type: 'HANDOFF_RECEIVED',
		});
		const detail = await ctx.as('leo').get(`/sessions/${id}`).expect(200);
		expect(detail.body.lastHandoff).toMatchObject({
			briefing: 'All yours.',
			from: { name: 'maya Tester' },
		});
	});

	it('an Editor can’t hand off (403); a Viewer, a non-member or yourself can’t receive it (400)', async () => {
		const id = await session();
		const send = (who: 'maya' | 'leo', toUserId: string) =>
			ctx
				.as(who)
				.post(`/sessions/${id}/handoff`)
				.send({ toUserId, briefing: 'b' });
		await send('leo', ctx.users.dana.id).expect(403);
		await send('maya', ctx.users.dana.id).expect(400);
		await send('maya', ctx.users.outsider.id).expect(400);
		await send('maya', ctx.users.maya.id).expect(400);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/handoff/preview`)
			.send({ toUserId: ctx.users.dana.id })
			.expect(400);
	});

	it('right after, the old Owner loses Owner-only actions and the new one has them', async () => {
		const id = await session();
		await ctx
			.as('maya')
			.post(`/sessions/${id}/handoff`)
			.send({ toUserId: ctx.users.leo.id, briefing: 'b' })
			.expect(201);
		await ctx
			.as('maya')
			.patch(`/sessions/${id}/status`)
			.send({ action: 'pause' })
			.expect(403);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/invites`)
			.send({ role: 'VIEWER' })
			.expect(403);
		await ctx
			.as('leo')
			.patch(`/sessions/${id}/status`)
			.send({ action: 'pause' })
			.expect(200);
		await ctx
			.as('leo')
			.post(`/sessions/${id}/invites`)
			.send({ role: 'VIEWER' })
			.expect(201);
	});

	it('pending approvals stay pending, and the new Owner can resolve them', async () => {
		const id = await session();
		const timeline = ctx.app.get(TimelineService);
		const approval = await timeline.transaction((tx) =>
			ctx.app.get(ApprovalService).request(tx, id, {
				kind: ApprovalKind.MARK_FINAL,
				title: 'Mark the document final',
			}),
		);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/handoff`)
			.send({ toUserId: ctx.users.leo.id, briefing: 'b' })
			.expect(201);
		expect(
			(
				await testPrisma.approval.findUniqueOrThrow({
					where: { id: approval.id },
				})
			).status,
		).toBe('PENDING');
		await ctx
			.as('leo')
			.post(`/sessions/${id}/approvals/${approval.id}`)
			.send({ decision: 'approve' })
			.expect(201);
	});
});
