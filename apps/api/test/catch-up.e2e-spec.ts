import {
	ActorType,
	ApprovalKind,
	EventType,
	SessionRole,
} from '@huddle/shared';
import { ApprovalService } from '@src/approval/approval.service';
import { LLM_PROVIDER_OVERRIDE, type ModelFactory } from '@src/llm/providers';
import { TimelineService } from '@src/timeline/timeline.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { type ScriptedModel, scriptedModel } from './utils/mock-llm';
import { E2EContext, setupE2E } from './utils/setup';

describe('Catch-up', () => {
	let ctx: E2EContext<'maya' | 'leo'>;
	let timeline: TimelineService;
	let mock: ScriptedModel = scriptedModel([]);
	const factory: ModelFactory = () => mock.model;

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo'],
			overrides: [{ provide: LLM_PROVIDER_OVERRIDE, useValue: factory }],
		});
		timeline = ctx.app.get(TimelineService);
	});
	afterAll(async () => {
		await ctx.close();
	});

	const say = (sessionId: string, text: string) =>
		timeline.record(sessionId, {
			type: EventType.AGENT_MESSAGE,
			actorType: ActorType.AGENT,
			payload: { text },
		});

	/** Session with Leo as Editor; events 1–5 seen by Leo, then `after` more. */
	async function session(after: (id: string) => Promise<void>) {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Catch-up', goal: 'Compare note apps' })
			.expect(201);
		const id = res.body.id as string;
		await testPrisma.sessionMember.create({
			data: {
				sessionId: id,
				userId: ctx.users.leo.id,
				role: SessionRole.EDITOR,
				lastSeenSeq: 5,
			},
		});
		for (let i = 0; i < 4; i++) await say(id, `seen ${i}`); // seq 2–5
		await after(id);
		return id;
	}

	it('counts what Leo missed after seq 5: 2 steps completed and 1 decision', async () => {
		mock = scriptedModel([
			{ text: 'The agent finished Notion and Obsidian; Maya pinned euros.' },
		]);
		const id = await session(async (sid) => {
			for (let i = 0; i < 6; i++) await say(sid, `filler ${i}`);
			for (const title of ['Notion', 'Obsidian']) {
				await timeline.record(sid, {
					type: EventType.STEP_COMPLETED,
					actorType: ActorType.AGENT,
					payload: { stepId: `step-${title}`, title },
				});
			}
			await ctx
				.as('maya')
				.post(`/sessions/${sid}/decisions`)
				.send({ content: 'Prices in euros' })
				.expect(201);
			for (let i = 0; i < 6; i++) await say(sid, `more ${i}`);
		});
		const res = await ctx.as('leo').get(`/sessions/${id}/catch-up`).expect(200);
		expect(res.body).toMatchObject({
			fromSeq: 5,
			toSeq: 20,
			unseenCount: 15,
			stepsCompleted: [
				{ title: 'Notion', seq: 12 },
				{ title: 'Obsidian', seq: 13 },
			],
			decisions: [{ content: 'Prices in euros', by: 'maya Tester', seq: 14 }],
			summary: 'The agent finished Notion and Obsidian; Maya pinned euros.',
		});
		expect(mock.promptText(0)).toContain(
			'The agent finished the section \\"Notion\\"',
		);
	});

	it('lists an approval Leo can resolve under waitingOnYou (and not before he can)', async () => {
		mock = scriptedModel([{ text: 's1' }, { text: 's2' }]);
		let approvalId = '';
		const id = await session(async (sid) => {
			const a = await timeline.transaction((tx) =>
				ctx.app.get(ApprovalService).request(tx, sid, {
					kind: ApprovalKind.MARK_FINAL,
					title: 'Mark the document final',
				}),
			);
			approvalId = a.id;
			await say(sid, 'x');
			await say(sid, 'y');
		});
		const before = await ctx
			.as('leo')
			.get(`/sessions/${id}/catch-up`)
			.expect(200);
		expect(before.body.waitingOnYou).toEqual([]);
		await ctx
			.as('maya')
			.patch(`/sessions/${id}/members/${ctx.users.leo.id}`)
			.send({ canApprove: true })
			.expect(200);
		const after = await ctx
			.as('leo')
			.get(`/sessions/${id}/catch-up`)
			.expect(200);
		expect(after.body.waitingOnYou).toEqual([
			{
				kind: 'approval',
				id: approvalId,
				title: 'Mark the document final',
				approvalKind: 'MARK_FINAL',
				seq: 6,
			},
		]);
	});

	it('seen only moves forward', async () => {
		const id = await session(async (sid) => {
			await say(sid, 'a');
			await say(sid, 'b');
		});
		const seen = (seq: number) =>
			ctx.as('leo').post(`/sessions/${id}/seen`).send({ seq }).expect(200);
		expect((await seen(7)).body.lastSeenSeq).toBe(7);
		expect((await seen(3)).body.lastSeenSeq).toBe(7);
		// Never past the newest event.
		expect((await seen(999)).body.lastSeenSeq).toBe(7);
	});

	it('a second catch-up for the same range doesn’t call the model again', async () => {
		mock = scriptedModel([{ text: 'Once.' }]);
		const id = await session(async (sid) => {
			for (let i = 0; i < 4; i++) await say(sid, `n${i}`);
		});
		const first = await ctx
			.as('leo')
			.get(`/sessions/${id}/catch-up`)
			.expect(200);
		const second = await ctx
			.as('leo')
			.get(`/sessions/${id}/catch-up`)
			.expect(200);
		expect(first.body.summary).toBe('Once.');
		expect(second.body.summary).toBe('Once.');
		expect(mock.calls).toHaveLength(1);
	});

	it('fewer than 3 unseen events: no summary and no model call', async () => {
		mock = scriptedModel([]);
		const id = await session(async (sid) => {
			await say(sid, 'just one');
			await say(sid, 'and two');
		});
		const res = await ctx.as('leo').get(`/sessions/${id}/catch-up`).expect(200);
		expect(res.body.unseenCount).toBe(2);
		expect(res.body.summary).toBeNull();
		expect(mock.calls).toHaveLength(0);
	});
});
