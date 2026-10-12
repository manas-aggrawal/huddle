import {
	ApprovalKind,
	ApprovalStatus,
	EventType,
	SessionRole,
	StepStatus,
} from '@huddle/shared';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import type { ScriptedStep } from './utils/mock-llm';
import { E2EContext, setupE2E } from './utils/setup';

const slow = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('Human plan editing', () => {
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

	/** A session with an outline (A, B, C) waiting for approval; Leo Editor, Dana Viewer. */
	async function planned(titles = ['A', 'B', 'C'], more: ScriptedStep[] = []) {
		agent.script([{ text: outlineReply(...titles) }, ...more]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Plan', goal: 'Compare note apps' })
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
		const steps = await testPrisma.planStep.findMany({
			where: { sessionId: id },
			orderBy: { position: 'asc' },
		});
		return { id, outline, steps };
	}
	const approve = (id: string, approvalId: string) =>
		ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${approvalId}`)
			.send({ decision: 'approve' })
			.expect(201);
	const titles = async (id: string) =>
		(
			await testPrisma.planStep.findMany({
				where: { sessionId: id },
				orderBy: { position: 'asc' },
			})
		).map((s) => [s.position, s.title]);
	const finished = (id: string) =>
		waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: {
						sessionId: id,
						kind: ApprovalKind.MARK_FINAL,
						status: ApprovalStatus.PENDING,
					},
				}),
			{ what: 'the run to finish', timeoutMs: 8000 },
		);

	it('reordering sets every position to match orderedIds and records PLAN_UPDATED', async () => {
		const { id, steps } = await planned();
		const [a, b, c] = steps;
		const res = await ctx
			.as('leo')
			.post(`/sessions/${id}/plan-steps/reorder`)
			.send({ orderedIds: [c.id, a.id, b.id] })
			.expect(201);
		expect(res.body.map((s: { title: string }) => s.title)).toEqual([
			'C',
			'A',
			'B',
		]);
		expect(await titles(id)).toEqual([
			[1, 'C'],
			[2, 'A'],
			[3, 'B'],
		]);
		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.PLAN_UPDATED, actorType: 'USER' },
		});
		expect(event.payload).toMatchObject({
			reason: 'edit',
			by: { name: 'leo Tester' },
		});
		await ctx
			.as('leo')
			.post(`/sessions/${id}/plan-steps/reorder`)
			.send({ orderedIds: [a.id, b.id] })
			.expect(400);
	});

	it('adds, renames, skips and deletes steps', async () => {
		const { id, steps } = await planned();
		const [a, b, c] = steps;
		await ctx
			.as('leo')
			.post(`/sessions/${id}/plan-steps`)
			.send({ title: 'Intro', after: null })
			.expect(201);
		await ctx
			.as('leo')
			.post(`/sessions/${id}/plan-steps`)
			.send({ title: 'Pricing', after: a.id })
			.expect(201);
		await ctx
			.as('leo')
			.patch(`/sessions/${id}/plan-steps/${b.id}`)
			.send({ title: 'B2' })
			.expect(200);
		await ctx
			.as('leo')
			.patch(`/sessions/${id}/plan-steps/${c.id}`)
			.send({ skipped: true })
			.expect(200);
		expect(await titles(id)).toEqual([
			[1, 'Intro'],
			[2, 'A'],
			[3, 'Pricing'],
			[4, 'B2'],
			[5, 'C'],
		]);
		expect(
			(await testPrisma.planStep.findUniqueOrThrow({ where: { id: c.id } }))
				.status,
		).toBe(StepStatus.SKIPPED);
		await ctx
			.as('leo')
			.delete(`/sessions/${id}/plan-steps/${a.id}`)
			.expect(200);
		expect((await titles(id)).map((t) => t[1])).toEqual([
			'Intro',
			'Pricing',
			'B2',
			'C',
		]);
	});

	it('the step being written can’t be deleted, moved or skipped (409)', async () => {
		const { id, steps } = await planned();
		const [a, b, c] = steps;
		await testPrisma.planStep.update({
			where: { id: a.id },
			data: { status: StepStatus.IN_PROGRESS },
		});
		await ctx
			.as('leo')
			.delete(`/sessions/${id}/plan-steps/${a.id}`)
			.expect(409);
		await ctx
			.as('leo')
			.patch(`/sessions/${id}/plan-steps/${a.id}`)
			.send({ skipped: true })
			.expect(409);
		await ctx
			.as('leo')
			.post(`/sessions/${id}/plan-steps/reorder`)
			.send({ orderedIds: [b.id, a.id, c.id] })
			.expect(409);
		// Others can still move around it.
		await ctx
			.as('leo')
			.post(`/sessions/${id}/plan-steps/reorder`)
			.send({ orderedIds: [a.id, c.id, b.id] })
			.expect(201);
	});

	it('a Viewer gets 403 on every plan endpoint', async () => {
		const { id, steps } = await planned();
		const as = ctx.as('dana');
		await as
			.post(`/sessions/${id}/plan-steps`)
			.send({ title: 'x' })
			.expect(403);
		await as
			.patch(`/sessions/${id}/plan-steps/${steps[0].id}`)
			.send({ title: 'x' })
			.expect(403);
		await as.delete(`/sessions/${id}/plan-steps/${steps[0].id}`).expect(403);
		await as
			.post(`/sessions/${id}/plan-steps/reorder`)
			.send({ orderedIds: steps.map((s) => s.id) })
			.expect(403);
	});

	it('a step added mid-run is written in its place, in the plan and in the doc', async () => {
		const { id, outline, steps } = await planned(
			['A', 'B'],
			[
				{ text: slow(60), chunkDelayMs: 10 },
				{ text: 'Pricing text.' },
				{ text: 'B text.' },
			],
		);
		await approve(id, outline.id);
		await waitFor(
			async () =>
				(
					await testPrisma.planStep.findUniqueOrThrow({
						where: { id: steps[0].id },
					})
				).status === StepStatus.IN_PROGRESS,
		);
		await ctx
			.as('leo')
			.post(`/sessions/${id}/plan-steps`)
			.send({ title: 'Pricing', after: steps[0].id })
			.expect(201);
		await finished(id);
		const doc = await ctx.app.get(AgentDocWriter).listSections(id);
		expect(doc.map((s) => [s.title, s.text])).toEqual([
			['A', slow(60)],
			['Pricing', 'Pricing text.'],
			['B', 'B text.'],
		]);
	});

	it('a step marked “needs approval” waits for a CUSTOM approval before it’s written', async () => {
		const { id, outline, steps } = await planned(
			['A', 'B'],
			[{ text: slow(40), chunkDelayMs: 10 }, { text: 'B text.' }],
		);
		await ctx
			.as('leo')
			.patch(`/sessions/${id}/plan-steps/${steps[1].id}`)
			.send({ requiresApproval: true })
			.expect(200);
		await approve(id, outline.id);
		const gate = await waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: {
						sessionId: id,
						kind: ApprovalKind.CUSTOM,
						status: ApprovalStatus.PENDING,
					},
				}),
			{ what: 'the step gate' },
		);
		expect(gate.planStepId).toBe(steps[1].id);
		expect(
			(
				await testPrisma.planStep.findUniqueOrThrow({
					where: { id: steps[0].id },
				})
			).status,
		).toBe(StepStatus.DONE);
		expect(
			(
				await testPrisma.planStep.findUniqueOrThrow({
					where: { id: steps[1].id },
				})
			).status,
		).toBe(StepStatus.PENDING);
		// The session isn't stopped by a step gate.
		expect(
			(await testPrisma.session.findUniqueOrThrow({ where: { id } })).status,
		).toBe('RUNNING');

		await approve(id, gate.id);
		await finished(id);
		expect(
			(
				await testPrisma.planStep.findUniqueOrThrow({
					where: { id: steps[1].id },
				})
			).status,
		).toBe(StepStatus.DONE);
	});

	it('adding a step while the agent waits to mark it final cancels that and writes the step', async () => {
		const { id, outline } = await planned(
			['A'],
			[{ text: 'A text.' }, { text: 'Extra text.' }],
		);
		await approve(id, outline.id);
		const final = await finished(id);
		await ctx
			.as('leo')
			.post(`/sessions/${id}/plan-steps`)
			.send({ title: 'Extra' })
			.expect(201);
		expect(
			(await testPrisma.approval.findUniqueOrThrow({ where: { id: final.id } }))
				.status,
		).toBe('CANCELLED');
		await waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: {
						sessionId: id,
						kind: ApprovalKind.MARK_FINAL,
						status: ApprovalStatus.PENDING,
						id: { not: final.id },
					},
				}),
			{ what: 'a new final approval' },
		);
		const extra = await testPrisma.planStep.findFirstOrThrow({
			where: { sessionId: id, title: 'Extra' },
		});
		expect(extra.status).toBe(StepStatus.DONE);
	});
});
