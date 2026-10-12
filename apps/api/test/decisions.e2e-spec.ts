import {
	ApprovalKind,
	ApprovalStatus,
	EventType,
	SessionRole,
} from '@huddle/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

describe('Pinned decisions', () => {
	const agent = agentHarness();
	let ctx: E2EContext<'maya' | 'leo' | 'dana'>;

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo', 'dana'],
			overrides: agent.overrides,
		});
	});
	afterAll(async () => {
		await ctx.close();
	});

	/** A session waiting on its outline, with Leo as Editor and Dana as Viewer. */
	async function session() {
		agent.script([{ text: outlineReply('A', 'B') }]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Decisions', goal: 'Compare note apps' })
			.expect(201);
		const id = res.body.id as string;
		await testPrisma.sessionMember.createMany({
			data: [
				{ sessionId: id, userId: ctx.users.leo.id, role: SessionRole.EDITOR },
				{ sessionId: id, userId: ctx.users.dana.id, role: SessionRole.VIEWER },
			],
		});
		const outline = await waitFor(() =>
			testPrisma.approval.findFirst({
				where: {
					sessionId: id,
					kind: ApprovalKind.OUTLINE,
					status: ApprovalStatus.PENDING,
				},
			}),
		);
		return { id, outline };
	}

	const pin = (who: 'maya' | 'leo' | 'dana', id: string, content: string) =>
		ctx.as(who).post(`/sessions/${id}/decisions`).send({ content });

	it('an Editor pins a decision (DECISION_PINNED); a Viewer gets 403', async () => {
		const { id } = await session();
		const res = await pin('leo', id, 'Use v2 pricing pages only').expect(201);
		expect(res.body).toMatchObject({
			content: 'Use v2 pricing pages only',
			origin: 'manual',
			createdBy: { id: ctx.users.leo.id, name: 'leo Tester' },
		});
		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.DECISION_PINNED },
		});
		expect(event.payload).toMatchObject({
			decisionId: res.body.id,
			content: 'Use v2 pricing pages only',
		});
		await pin('dana', id, 'nope').expect(403);
		await pin('leo', id, '   ').expect(400);
	});

	it('unpinning sets unpinnedAt and drops it from the active list', async () => {
		const { id } = await session();
		const kept = (await pin('maya', id, 'Keep this')).body;
		const dropped = (await pin('maya', id, 'Drop this')).body;
		await ctx
			.as('dana')
			.delete(`/sessions/${id}/decisions/${dropped.id}`)
			.expect(403);
		await ctx
			.as('leo')
			.delete(`/sessions/${id}/decisions/${dropped.id}`)
			.expect(204);
		await ctx
			.as('leo')
			.delete(`/sessions/${id}/decisions/${dropped.id}`)
			.expect(404);

		const row = await testPrisma.decision.findUniqueOrThrow({
			where: { id: dropped.id },
		});
		expect(row.unpinnedAt).not.toBeNull();
		const detail = await ctx.as('dana').get(`/sessions/${id}`).expect(200);
		expect(detail.body.decisions.map((d: { id: string }) => d.id)).toEqual([
			kept.id,
		]);
		expect(
			await testPrisma.timelineEvent.count({
				where: { sessionId: id, type: EventType.DECISION_UNPINNED },
			}),
		).toBe(1);
	});

	it('the section prompt carries every active decision and no unpinned one', async () => {
		const { id, outline } = await session();
		await pin('maya', id, 'Prices in euros');
		const gone = (await pin('maya', id, 'Mention Evernote')).body;
		await ctx
			.as('maya')
			.delete(`/sessions/${id}/decisions/${gone.id}`)
			.expect(204);

		agent.script([{ text: 'A text.' }, { text: 'B text.' }]);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${outline.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		await waitFor(() =>
			testPrisma.approval.findFirst({
				where: { sessionId: id, kind: ApprovalKind.MARK_FINAL },
			}),
		);
		for (const i of [0, 1]) {
			expect(agent.model.promptText(i)).toContain('Prices in euros');
			expect(agent.model.promptText(i)).not.toContain('Mention Evernote');
		}
	});

	it('answering an approval with a note pins it as a decision', async () => {
		const { id, outline } = await session();
		agent.script([{ text: outlineReply('A', 'B', 'Bear') }]);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${outline.id}`)
			.send({ decision: 'reject', note: 'Include Bear' })
			.expect(201);
		const decision = await testPrisma.decision.findFirstOrThrow({
			where: { sessionId: id, approvalId: outline.id },
		});
		expect(decision.content).toBe('On “Approve the outline”: Include Bear');
		const detail = await ctx.as('maya').get(`/sessions/${id}`).expect(200);
		expect(detail.body.decisions[0]).toMatchObject({
			origin: 'approval',
			createdBy: { name: 'maya Tester' },
		});
	});
});
