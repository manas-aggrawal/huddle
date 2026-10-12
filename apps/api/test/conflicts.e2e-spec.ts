import {
	ApprovalKind,
	ApprovalStatus,
	EventType,
	SessionRole,
	StepStatus,
} from '@huddle/shared';
import { AgentRunner } from '@src/agent/agent-runner.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

const IDS = /id ([0-9a-f-]{36})/g;
const slow = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

/** A queue reply that reports the queued messages as conflicting about step 3. */
const conflictReply = (prompt: string) => {
	const ids = [...prompt.matchAll(IDS)].map((m) => m[1]);
	return JSON.stringify({
		conflicts: [
			{
				messageIds: ids,
				summary: 'Leo wants a short verdict, Raj wants a long one',
				position: 3,
			},
		],
		decisions: ids.map((messageId) => ({
			messageId,
			decision: 'apply',
			reply: 'ok',
		})),
	});
};

describe('Conflicts', () => {
	const agent = agentHarness();
	let ctx: E2EContext<'maya' | 'leo' | 'raj'>;

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo', 'raj'],
			overrides: agent.overrides,
		});
	});
	afterAll(async () => {
		await ctx.close();
	});

	/** Runs A, B, Verdict. Leo and Raj disagree while A is written. */
	async function conflicted() {
		agent.script([
			{ text: outlineReply('A', 'B', 'Verdict') },
			{ text: slow(60), chunkDelayMs: 10 },
			{ text: conflictReply },
			{ text: 'B text.' },
		]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Conflicts', goal: 'Compare note apps' })
			.expect(201);
		const id = res.body.id as string;
		await testPrisma.sessionMember.createMany({
			data: [
				{ sessionId: id, userId: ctx.users.leo.id, role: SessionRole.EDITOR },
				{ sessionId: id, userId: ctx.users.raj.id, role: SessionRole.EDITOR },
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
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${outline.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		await waitFor(
			async () =>
				(
					await testPrisma.planStep.findFirst({
						where: { sessionId: id, title: 'A' },
					})
				)?.status === StepStatus.IN_PROGRESS,
		);
		const a = (
			await ctx
				.as('leo')
				.post(`/sessions/${id}/messages`)
				.send({ mode: 'SUGGEST', content: 'Keep the verdict to one line' })
				.expect(201)
		).body.id;
		const b = (
			await ctx
				.as('raj')
				.post(`/sessions/${id}/messages`)
				.send({ mode: 'SUGGEST', content: 'Make the verdict a full page' })
				.expect(201)
		).body.id;
		const conflict = await waitFor(
			() =>
				testPrisma.conflict.findFirst({
					where: { sessionId: id },
					include: { messages: true },
				}),
			{ what: 'the conflict' },
		);
		return { id, a, b, conflict };
	}

	it('a reported conflict links both messages, blocks its step, and the rest of the plan goes on', async () => {
		const { id, a, b, conflict } = await conflicted();
		expect(conflict.messages.map((m) => m.id).sort()).toEqual([a, b].sort());
		expect(conflict.summary).toBe(
			'Leo wants a short verdict, Raj wants a long one',
		);

		const verdict = await testPrisma.planStep.findFirstOrThrow({
			where: { sessionId: id, title: 'Verdict' },
		});
		expect(verdict.status).toBe(StepStatus.BLOCKED);
		expect(conflict.planStepId).toBe(verdict.id);

		// B still gets written; then the agent waits (no final approval while blocked).
		await waitFor(
			async () =>
				(
					await testPrisma.planStep.findFirstOrThrow({
						where: { sessionId: id, title: 'B' },
					})
				).status === StepStatus.DONE,
		);
		await ctx.app.get(AgentRunner).settled(id);
		expect(
			await testPrisma.approval.count({
				where: { sessionId: id, kind: ApprovalKind.MARK_FINAL },
			}),
		).toBe(0);

		for (const mid of [a, b]) {
			const m = await testPrisma.message.findUniqueOrThrow({
				where: { id: mid },
			});
			expect(m.status).toBe('ACKNOWLEDGED');
			expect(m.response).toContain('flagged it for the Owner');
		}
		const raised = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.CONFLICT_RAISED },
		});
		expect(raised.payload).toMatchObject({
			conflictId: conflict.id,
			stepTitle: 'Verdict',
			sides: expect.arrayContaining([
				expect.objectContaining({
					author: expect.objectContaining({ name: 'leo Tester' }),
				}),
				expect.objectContaining({
					author: expect.objectContaining({ name: 'raj Tester' }),
				}),
			]),
		});
		const notified = await testPrisma.notification.findMany({
			where: { refId: conflict.id, type: 'CONFLICT_RAISED' },
		});
		expect(notified.map((n) => n.userId).sort()).toEqual(
			[ctx.users.maya.id, ctx.users.leo.id, ctx.users.raj.id].sort(),
		);
		const detail = await ctx.as('leo').get(`/sessions/${id}`).expect(200);
		expect(detail.body.openConflicts).toEqual([
			expect.objectContaining({ id: conflict.id, planStepId: verdict.id }),
		]);
	});

	it('only the Owner resolves: the step unblocks, a decision is pinned, and the agent finishes', async () => {
		const { id, conflict } = await conflicted();
		await waitFor(
			async () =>
				(
					await testPrisma.planStep.findFirstOrThrow({
						where: { sessionId: id, title: 'B' },
					})
				).status === StepStatus.DONE,
		);
		await ctx.app.get(AgentRunner).settled(id);

		const url = `/sessions/${id}/conflicts/${conflict.id}/resolve`;
		await ctx.as('leo').post(url).send({ resolution: 'One line' }).expect(403);

		agent.script([{ text: 'Verdict: Notion.' }]);
		await ctx
			.as('maya')
			.post(url)
			.send({ resolution: 'One short paragraph' })
			.expect(201);
		await ctx.as('maya').post(url).send({ resolution: 'again' }).expect(409);

		const resolved = await testPrisma.conflict.findUniqueOrThrow({
			where: { id: conflict.id },
		});
		expect(resolved.resolvedAt).not.toBeNull();
		expect(resolved.resolvedById).toBe(ctx.users.maya.id);
		const decision = await testPrisma.decision.findFirstOrThrow({
			where: { conflictId: conflict.id },
		});
		expect(decision.content).toBe('One short paragraph');

		await waitFor(() =>
			testPrisma.approval.findFirst({
				where: { sessionId: id, kind: ApprovalKind.MARK_FINAL },
			}),
		);
		const verdict = await testPrisma.planStep.findFirstOrThrow({
			where: { sessionId: id, title: 'Verdict' },
		});
		expect(verdict.status).toBe(StepStatus.DONE);
		// The Verdict section was written knowing the resolution.
		expect(agent.model.promptText(0)).toContain('One short paragraph');
		const types = (
			await testPrisma.timelineEvent.findMany({
				where: { sessionId: id },
				orderBy: { seq: 'asc' },
			})
		).map((e) => e.type);
		expect(types).toContain(EventType.CONFLICT_RESOLVED);
		expect(types.indexOf(EventType.DECISION_PINNED)).toBeGreaterThan(
			types.indexOf(EventType.CONFLICT_RESOLVED),
		);
	});
});
