import {
	ApprovalKind,
	ApprovalStatus,
	EventType,
	SessionRole,
	StepStatus,
} from '@huddle/shared';
import { AgentRunner } from '@src/agent/agent-runner.service';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import type { ScriptedStep } from './utils/mock-llm';
import { E2EContext, setupE2E } from './utils/setup';

const slow = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const replan = (reply: string, planOps: unknown[] = []) =>
	JSON.stringify({ reply, planOps });

describe('Agent: interrupt and replan', () => {
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

	async function runningSession(script: ScriptedStep[]) {
		agent.script(script);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Note apps', goal: 'Compare note apps' })
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
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${outline.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		return id;
	}

	const step = (sessionId: string, title: string) =>
		testPrisma.planStep.findFirstOrThrow({ where: { sessionId, title } });
	const textOf = async (sessionId: string, title: string) =>
		(await ctx.app.get(AgentDocWriter).listSections(sessionId)).find(
			(s) => s.title === title,
		)?.text ?? '';
	const interrupt = (
		sessionId: string,
		content: string,
		who: 'leo' | 'dana' = 'leo',
	) =>
		ctx
			.as(who)
			.post(`/sessions/${sessionId}/messages`)
			.send({ mode: 'INTERRUPT', content });
	const finished = (sessionId: string) =>
		waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: { sessionId, kind: ApprovalKind.MARK_FINAL },
				}),
			{ what: 'the run to finish', timeoutMs: 8000 },
		);

	it('an interrupt mid-section stops the stream within a second and keeps the partial text', async () => {
		const id = await runningSession([
			{ text: outlineReply('A', 'B') },
			{ text: slow(300), chunkDelayMs: 10 },
			{
				text: replan('Dropping A, Leo, as you asked.', [
					{ op: 'remove', position: 1 },
				]),
			},
			{ text: 'B text.' },
		]);
		await waitFor(async () => (await textOf(id, 'A')).length > 30);
		await interrupt(id, 'Stop, skip A entirely').expect(201);

		await new Promise((r) => setTimeout(r, 1000));
		const after1s = await textOf(id, 'A');
		await finished(id);
		expect(await textOf(id, 'A')).toBe(after1s);
		expect(after1s.length).toBeGreaterThan(30);
		expect(after1s.length).toBeLessThan(slow(300).length);
		expect((await step(id, 'A')).status).toBe(StepStatus.SKIPPED);
		expect((await step(id, 'B')).status).toBe(StepStatus.DONE);

		const update = await testPrisma.timelineEvent.findFirstOrThrow({
			where: {
				sessionId: id,
				type: EventType.PLAN_UPDATED,
				payload: { path: ['reason'], equals: 'interrupt' },
			},
		});
		expect(update.payload).toMatchObject({
			by: { name: 'leo Tester' },
			diff: { removed: ['A'] },
		});
		// Acknowledged at once, applied after the replan.
		const acks = await testPrisma.timelineEvent.findMany({
			where: { sessionId: id, type: EventType.AGENT_ACK },
			orderBy: { seq: 'asc' },
		});
		expect(acks.map((a) => (a.payload as { status: string }).status)).toEqual([
			'ACKNOWLEDGED',
			'APPLIED',
		]);
	});

	it('after a replan, the new plan is applied and the runner continues with the new next step', async () => {
		const id = await runningSession([
			{ text: outlineReply('A', 'B') },
			{ text: slow(200), chunkDelayMs: 10 },
			{
				text: replan('Renamed B and added pricing, Leo.', [
					{ op: 'edit', position: 2, title: 'B2' },
					{ op: 'add', title: 'Pricing', after: 1 },
				]),
			},
			{ text: 'rest of A.' },
			{ text: 'Pricing text.' },
			{ text: 'B2 text.' },
		]);
		await waitFor(async () => (await textOf(id, 'A')).length > 20);
		await interrupt(id, 'Add pricing right after A, and rename B').expect(201);
		await finished(id);

		const completed = await testPrisma.timelineEvent.findMany({
			where: { sessionId: id, type: EventType.STEP_COMPLETED },
			orderBy: { seq: 'asc' },
		});
		expect(
			completed.map((e) => (e.payload as { title: string }).title),
		).toEqual(['A', 'Pricing', 'B2']);
		const doc = await ctx.app.get(AgentDocWriter).listSections(id);
		expect(doc.map((s) => s.title)).toEqual(['A', 'Pricing', 'B2']);
		expect(doc[0].text.endsWith('rest of A.')).toBe(true);
		// The replan saw what was written and who asked.
		expect(agent.model.promptText(2)).toContain(
			'leo Tester (editor) interrupted you',
		);
	});

	it('two quick interrupts are both handled, in order, by one runner', async () => {
		const id = await runningSession([
			{ text: outlineReply('A', 'B') },
			{ text: slow(200), chunkDelayMs: 10 },
			{ text: replan('First one handled.', [{ op: 'add', title: 'X' }]) },
			{ text: replan('Second one handled.', [{ op: 'add', title: 'Y' }]) },
			{ text: 'A rest.' },
			{ text: 'B text.' },
			{ text: 'X text.' },
			{ text: 'Y text.' },
		]);
		await waitFor(async () => (await textOf(id, 'A')).length > 20);
		const first = (await interrupt(id, 'Add X').expect(201)).body.id;
		const second = (await interrupt(id, 'Add Y').expect(201)).body.id;
		expect(ctx.app.get(AgentRunner).isRunning(id)).toBe(true);
		await finished(id);

		const updates = await testPrisma.timelineEvent.findMany({
			where: {
				sessionId: id,
				type: EventType.PLAN_UPDATED,
				payload: { path: ['reason'], equals: 'interrupt' },
			},
			orderBy: { seq: 'asc' },
		});
		expect(
			updates.map((u) => (u.payload as { messageId: string }).messageId),
		).toEqual([first, second]);
		const titles = (
			await testPrisma.planStep.findMany({
				where: { sessionId: id },
				orderBy: { position: 'asc' },
			})
		).map((s) => s.title);
		expect(titles).toEqual(['A', 'B', 'X', 'Y']);
		for (const mid of [first, second]) {
			expect(
				(await testPrisma.message.findUniqueOrThrow({ where: { id: mid } }))
					.status,
			).toBe('APPLIED');
		}
	});

	it('an Editor can interrupt; a Viewer gets 403', async () => {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Perms', goal: 'g' })
			.expect(201);
		await testPrisma.session.update({
			where: { id: res.body.id },
			data: { status: 'DONE' },
		});
		await testPrisma.sessionMember.create({
			data: {
				sessionId: res.body.id,
				userId: ctx.users.dana.id,
				role: SessionRole.VIEWER,
			},
		});
		await interrupt(res.body.id, 'stop', 'dana').expect(403);
	});
});
