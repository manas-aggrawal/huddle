import {
	ApprovalKind,
	ApprovalStatus,
	EventType,
	SessionRole,
	StepStatus,
} from '@huddle/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import type { ScriptedStep } from './utils/mock-llm';
import { E2EContext, setupE2E } from './utils/setup';

const MESSAGE_ID = /id ([0-9a-f-]{36})/;

/** A queue reply that answers the (single) queued message in the prompt. */
const queueReply =
	(decision: string, reply: string, planOps: unknown[] = []) =>
	(prompt: string) =>
		JSON.stringify({
			decisions: [
				{ messageId: prompt.match(MESSAGE_ID)?.[1], decision, reply, planOps },
			],
		});

const slow = (n: number) =>
	Array.from({ length: n }, (_, i) => `s${i}`).join(' ');

describe('Agent: suggestions at section boundaries, and Asks', () => {
	const agent = agentHarness();
	let ctx: E2EContext<'maya' | 'leo'>;

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo'],
			overrides: agent.overrides,
		});
	});
	afterAll(async () => {
		await ctx.close();
	});

	/** Creates a session with Leo as Editor, approves the outline, and lets the agent go. */
	async function runningSession(script: ScriptedStep[]) {
		agent.script(script);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Note apps', goal: 'Compare note apps' })
			.expect(201);
		const id = res.body.id as string;
		await testPrisma.sessionMember.create({
			data: {
				sessionId: id,
				userId: ctx.users.leo.id,
				role: SessionRole.EDITOR,
			},
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

	const stepNamed = (sessionId: string, title: string) =>
		testPrisma.planStep.findFirstOrThrow({ where: { sessionId, title } });

	const finished = (sessionId: string) =>
		waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: { sessionId, kind: ApprovalKind.MARK_FINAL },
				}),
			{ what: 'the run to finish' },
		);

	const suggest = (sessionId: string, content: string, mode = 'SUGGEST') =>
		ctx
			.as('leo')
			.post(`/sessions/${sessionId}/messages`)
			.send({ mode, content })
			.expect(201)
			.then((r) => r.body.id as string);

	it('a Suggest sent mid-section waits for the section to finish, then is applied and acknowledged by name', async () => {
		const id = await runningSession([
			{ text: outlineReply('A', 'B', 'C') },
			{ text: 'Section A.' },
			{ text: slow(60), chunkDelayMs: 10 },
			{ text: queueReply('apply', 'Got it, Leo — I’ll add UX notes.') },
			{ text: 'Section C with UX notes.' },
		]);
		await waitFor(
			async () => (await stepNamed(id, 'B')).status === StepStatus.IN_PROGRESS,
		);
		const messageId = await suggest(id, 'Add UX notes to each profile');

		// Still writing B: the suggestion waits.
		await new Promise((r) => setTimeout(r, 100));
		expect((await stepNamed(id, 'B')).status).toBe(StepStatus.IN_PROGRESS);
		expect(
			(await testPrisma.message.findUniqueOrThrow({ where: { id: messageId } }))
				.status,
		).toBe('QUEUED');

		await finished(id);
		const message = await testPrisma.message.findUniqueOrThrow({
			where: { id: messageId },
		});
		expect(message).toMatchObject({
			status: 'APPLIED',
			response: 'Got it, Leo — I’ll add UX notes.',
		});
		expect(message.processedAt).not.toBeNull();

		const events = await testPrisma.timelineEvent.findMany({
			where: { sessionId: id },
			orderBy: { seq: 'asc' },
		});
		const seqOf = (pred: (e: (typeof events)[number]) => boolean) =>
			events.find(pred)?.seq ?? -1;
		const doneB = seqOf(
			(e) =>
				e.type === EventType.STEP_COMPLETED &&
				(e.payload as { title: string }).title === 'B',
		);
		const ack = events.find((e) => e.type === EventType.AGENT_ACK);
		const startC = seqOf(
			(e) =>
				e.type === EventType.STEP_STARTED &&
				(e.payload as { title: string }).title === 'C',
		);
		expect(ack?.seq).toBeGreaterThan(doneB);
		expect(ack?.seq).toBeLessThan(startC);
		expect(ack?.payload).toMatchObject({
			messageId,
			author: { id: ctx.users.leo.id, name: 'leo Tester' },
			status: 'APPLIED',
		});
		// Applied suggestions guide the sections that follow.
		expect(agent.model.promptText(4)).toContain('Add UX notes to each profile');
		// The queue prompt named the author and role.
		expect(agent.model.promptText(3)).toContain('leo Tester (editor)');
	});

	it('a plan_change inserts the new step where the model asked, with a PLAN_UPDATED diff', async () => {
		const id = await runningSession([
			{ text: outlineReply('A', 'B', 'C') },
			{ text: slow(40), chunkDelayMs: 10 },
			{
				text: queueReply('plan_change', 'Sure Leo, adding UX notes after B.', [
					{ op: 'add', title: 'UX notes', description: 'Usability', after: 2 },
				]),
			},
			{ text: 'B text.' },
			{ text: 'UX notes text.' },
			{ text: 'C text.' },
		]);
		await waitFor(
			async () => (await stepNamed(id, 'A')).status === StepStatus.IN_PROGRESS,
		);
		await suggest(id, 'Add a UX notes section');
		await finished(id);

		const steps = await testPrisma.planStep.findMany({
			where: { sessionId: id },
			orderBy: { position: 'asc' },
		});
		expect(steps.map((s) => [s.position, s.title, s.status])).toEqual([
			[1, 'A', 'DONE'],
			[2, 'B', 'DONE'],
			[3, 'UX notes', 'DONE'],
			[4, 'C', 'DONE'],
		]);
		const update = await testPrisma.timelineEvent.findFirstOrThrow({
			where: {
				sessionId: id,
				type: EventType.PLAN_UPDATED,
				payload: { path: ['reason'], equals: 'suggestion' },
			},
		});
		expect(update.payload).toMatchObject({
			by: { name: 'leo Tester' },
			diff: { added: ['UX notes'], removed: [], changed: [], moved: [] },
		});
	});

	it('a decline sets DECLINED with the reason', async () => {
		const id = await runningSession([
			{ text: outlineReply('A', 'B') },
			{ text: slow(30), chunkDelayMs: 10 },
			{
				text: queueReply(
					'decline',
					'Sorry Leo, that’s out of scope for this comparison.',
				),
			},
			{ text: 'B text.' },
		]);
		await waitFor(
			async () => (await stepNamed(id, 'A')).status === StepStatus.IN_PROGRESS,
		);
		const messageId = await suggest(id, 'Write about the history of paper');
		await finished(id);
		expect(
			await testPrisma.message.findUniqueOrThrow({ where: { id: messageId } }),
		).toMatchObject({
			status: 'DECLINED',
			response: 'Sorry Leo, that’s out of scope for this comparison.',
		});
	});

	it('an Ask during writing is answered before the section finishes, without touching the plan', async () => {
		const id = await runningSession([
			{ text: outlineReply('A', 'B') },
			{ text: slow(120), chunkDelayMs: 10 },
			{ text: 'Because it has the most users, Leo.' },
			{ text: 'B text.' },
		]);
		await waitFor(
			async () => (await stepNamed(id, 'A')).status === StepStatus.IN_PROGRESS,
		);
		const before = await testPrisma.planStep.findMany({
			where: { sessionId: id },
		});
		const messageId = await suggest(id, 'Why is Notion first?', 'ASK');

		await waitFor(
			async () =>
				(
					await testPrisma.message.findUniqueOrThrow({
						where: { id: messageId },
					})
				).status === 'ANSWERED',
		);
		expect((await stepNamed(id, 'A')).status).toBe(StepStatus.IN_PROGRESS);
		const reply = await testPrisma.timelineEvent.findFirstOrThrow({
			where: {
				sessionId: id,
				type: EventType.AGENT_MESSAGE,
				payload: { path: ['replyTo'], equals: messageId },
			},
		});
		expect(reply.payload).toMatchObject({
			text: 'Because it has the most users, Leo.',
			to: { name: 'leo Tester' },
		});
		expect(agent.model.promptText(2)).toContain(
			'leo Tester (editor) asks: Why is Notion first?',
		);

		await finished(id);
		const after = await testPrisma.planStep.findMany({
			where: { sessionId: id },
		});
		expect(after.map((s) => s.title).sort()).toEqual(
			before.map((s) => s.title).sort(),
		);
		expect(
			await testPrisma.timelineEvent.count({
				where: { sessionId: id, type: EventType.AGENT_ACK },
			}),
		).toBe(0);
	});
});
