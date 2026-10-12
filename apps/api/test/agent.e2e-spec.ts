import {
	ApprovalKind,
	ApprovalStatus,
	EventType,
	SessionStatus,
	StepStatus,
} from '@huddle/shared';
import { AgentRunner } from '@src/agent/agent-runner.service';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

describe('Agent runner', () => {
	const agent = agentHarness();
	let ctx: E2EContext<'maya'>;
	let closed = false;

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya'], overrides: agent.overrides });
	});
	afterAll(async () => {
		if (!closed) await ctx.close();
	});

	async function createSession(app = ctx) {
		const res = await app
			.as('maya')
			.post('/sessions')
			.send({ title: 'Note apps', goal: 'Compare the top note-taking apps' })
			.expect(201);
		return res.body.id as string;
	}

	const pendingApproval = (sessionId: string, kind: ApprovalKind) =>
		testPrisma.approval.findFirst({
			where: { sessionId, kind, status: ApprovalStatus.PENDING },
		});

	const approve = (sessionId: string, approvalId: string, app = ctx) =>
		app
			.as('maya')
			.post(`/sessions/${sessionId}/approvals/${approvalId}`)
			.send({ decision: 'approve' })
			.expect(201);

	const sections = (sessionId: string, app = ctx) =>
		app.app.get(AgentDocWriter).listSections(sessionId);

	it('plans an outline, saves it as steps, and waits for approval', async () => {
		agent.script([{ text: outlineReply('Notion', 'Obsidian') }]);
		const id = await createSession();

		const approval = await waitFor(
			() => pendingApproval(id, ApprovalKind.OUTLINE),
			{ what: 'the outline approval' },
		);
		expect(approval.details).toEqual({
			steps: [
				{ title: 'Notion', description: 'About Notion' },
				{ title: 'Obsidian', description: 'About Obsidian' },
			],
		});
		const steps = await testPrisma.planStep.findMany({
			where: { sessionId: id },
			orderBy: { position: 'asc' },
		});
		expect(steps.map((s) => [s.position, s.title, s.status])).toEqual([
			[1, 'Notion', StepStatus.PENDING],
			[2, 'Obsidian', StepStatus.PENDING],
		]);
		const session = await testPrisma.session.findUniqueOrThrow({
			where: { id },
		});
		expect(session.status).toBe(SessionStatus.WAITING);
		expect(agent.model.promptText(0)).toContain(
			'Compare the top note-taking apps',
		);
	});

	it('after approval, writes every section in order, then asks to mark it final', async () => {
		agent.script([
			{ text: outlineReply('Notion', 'Obsidian') },
			{ text: 'Notion is an all-in-one workspace.\n\nIt has databases.' },
			{ text: 'Obsidian stores notes as local Markdown files.' },
		]);
		const id = await createSession();
		const outline = await waitFor(() =>
			pendingApproval(id, ApprovalKind.OUTLINE),
		);
		await approve(id, outline.id);

		await waitFor(() => pendingApproval(id, ApprovalKind.MARK_FINAL), {
			what: 'the mark-final approval',
		});
		const steps = await testPrisma.planStep.findMany({
			where: { sessionId: id },
			orderBy: { position: 'asc' },
		});
		expect(steps.every((s) => s.status === StepStatus.DONE)).toBe(true);

		const doc = await sections(id);
		expect(doc.map((s) => [s.title, s.text])).toEqual([
			['Notion', 'Notion is an all-in-one workspace.\n\nIt has databases.'],
			['Obsidian', 'Obsidian stores notes as local Markdown files.'],
		]);
		expect(doc.map((s) => s.sectionId)).toEqual(steps.map((s) => s.sectionId));

		// The timeline tells the story in order.
		const events = await testPrisma.timelineEvent.findMany({
			where: { sessionId: id },
			orderBy: { seq: 'asc' },
		});
		const story = events
			.filter((e) =>
				(
					[
						EventType.STEP_STARTED,
						EventType.STEP_COMPLETED,
						EventType.APPROVAL_REQUESTED,
						EventType.APPROVAL_RESOLVED,
					] as string[]
				).includes(e.type),
			)
			.map((e) => {
				const p = e.payload as { title?: string; kind?: string };
				return `${e.type}:${p.kind ?? p.title}`;
			});
		expect(story).toEqual([
			'APPROVAL_REQUESTED:OUTLINE',
			'APPROVAL_RESOLVED:OUTLINE',
			'STEP_STARTED:Notion',
			'STEP_COMPLETED:Notion',
			'STEP_STARTED:Obsidian',
			'STEP_COMPLETED:Obsidian',
			'APPROVAL_REQUESTED:MARK_FINAL',
		]);
		const finished = events.filter(
			(e) =>
				e.type === EventType.AGENT_MESSAGE &&
				String((e.payload as { text?: string }).text).startsWith('Finished'),
		);
		expect(finished).toHaveLength(2);
		const session = await testPrisma.session.findUniqueOrThrow({
			where: { id },
		});
		expect(session.status).toBe(SessionStatus.WAITING);
		expect(session.agentState).toBe('IDLE');
	});

	it('the creator’s context goes into the outline prompt and is acknowledged by name', async () => {
		agent.script([{ text: outlineReply('Pricing') }]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({
				title: 'Pricing',
				goal: 'Compare pricing',
				context: 'Focus on team plans',
			})
			.expect(201);
		const id = res.body.id;
		await waitFor(() => pendingApproval(id, ApprovalKind.OUTLINE));

		expect(agent.model.promptText(0)).toContain('Focus on team plans');
		const message = await testPrisma.message.findFirstOrThrow({
			where: { sessionId: id },
		});
		expect(message.status).toBe('APPLIED');
		const ack = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.AGENT_ACK },
		});
		expect(ack.payload).toMatchObject({
			messageId: message.id,
			author: { name: 'maya Tester' },
		});
	});

	it('two start triggers for the same session run only one agent', async () => {
		agent.script([
			{ text: outlineReply('Only once'), chunkDelayMs: 0 },
			{ text: outlineReply('Never') },
		]);
		const id = await createSession();
		const runner = ctx.app.get(AgentRunner);
		runner.wake(id);
		runner.wake(id);
		await waitFor(() => pendingApproval(id, ApprovalKind.OUTLINE));
		await runner.settled(id);

		expect(agent.model.calls).toHaveLength(1);
		expect(await testPrisma.approval.count({ where: { sessionId: id } })).toBe(
			1,
		);
	});

	it('an invalid outline gets one retry, then an error message, and the session stays in PLANNING', async () => {
		agent.script([
			{ text: 'Sure! Here is an outline: 1. Notion' },
			{ text: '{"steps": []}' },
		]);
		const id = await createSession();
		const error = await waitFor(
			() =>
				testPrisma.timelineEvent.findFirst({
					where: { sessionId: id, type: EventType.AGENT_MESSAGE },
				}),
			{ what: 'the error message' },
		);
		expect(error.payload).toMatchObject({ kind: 'error' });
		expect(agent.model.calls).toHaveLength(2);
		expect(agent.model.promptText(1)).toContain('previous reply was invalid');

		const session = await testPrisma.session.findUniqueOrThrow({
			where: { id },
		});
		expect(session.status).toBe(SessionStatus.PLANNING);
		expect(await testPrisma.planStep.count({ where: { sessionId: id } })).toBe(
			0,
		);
	});

	it('a rejected outline is revised using the note', async () => {
		agent.script([
			{ text: outlineReply('Notion') },
			{ text: outlineReply('Notion', 'Bear') },
		]);
		const id = await createSession();
		const first = await waitFor(() =>
			pendingApproval(id, ApprovalKind.OUTLINE),
		);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${first.id}`)
			.send({ decision: 'reject', note: 'Add Bear' })
			.expect(201);

		const second = await waitFor(async () => {
			const a = await pendingApproval(id, ApprovalKind.OUTLINE);
			return a && a.id !== first.id ? a : null;
		});
		expect(second.title).toBe('Approve the revised outline');
		expect(agent.model.promptText(1)).toContain('Add Bear');
		const titles = (
			await testPrisma.planStep.findMany({
				where: { sessionId: id },
				orderBy: { position: 'asc' },
			})
		).map((s) => s.title);
		expect(titles).toEqual(['Notion', 'Bear']);
	});

	it('pausing stops the writing; resuming finishes it without duplicating the section', async () => {
		const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
		agent.script([
			{ text: outlineReply('Long one') },
			{ text: long, chunkDelayMs: 10 },
			{ text: 'The rest of it.' },
		]);
		const id = await createSession();
		const outline = await waitFor(() =>
			pendingApproval(id, ApprovalKind.OUTLINE),
		);
		await approve(id, outline.id);
		await waitFor(async () => (await sections(id))[0]?.text.length > 20);

		await ctx
			.as('maya')
			.patch(`/sessions/${id}/status`)
			.send({ action: 'pause' })
			.expect(200);
		await ctx.app.get(AgentRunner).settled(id);
		const paused = (await sections(id))[0].text;
		expect(paused.length).toBeLessThan(long.length);
		const step = await testPrisma.planStep.findFirstOrThrow({
			where: { sessionId: id },
		});
		expect(step.status).toBe(StepStatus.IN_PROGRESS);

		await ctx
			.as('maya')
			.patch(`/sessions/${id}/status`)
			.send({ action: 'resume' })
			.expect(200);
		await waitFor(() => pendingApproval(id, ApprovalKind.MARK_FINAL));
		const doc = await sections(id);
		expect(doc).toHaveLength(1);
		expect(doc[0].text.startsWith(paused)).toBe(true);
		expect(doc[0].text.endsWith('The rest of it.')).toBe(true);
		// The resumed call was told what's already written.
		expect(agent.model.promptText(2)).toContain(paused.slice(0, 30));
	});

	it('after a restart, a RUNNING session resumes at the first unfinished step without duplicating sections', async () => {
		const long = Array.from({ length: 200 }, (_, i) => `x${i}`).join(' ');
		agent.script([
			{ text: outlineReply('First', 'Second') },
			{ text: 'First section text.' },
			{ text: long, chunkDelayMs: 10 },
		]);
		const id = await createSession();
		const outline = await waitFor(() =>
			pendingApproval(id, ApprovalKind.OUTLINE),
		);
		await approve(id, outline.id);
		await waitFor(async () => (await sections(id))[1]?.text.length > 20, {
			what: 'section 2 to start',
		});
		// Only this session should resume after the restart.
		await testPrisma.session.updateMany({
			where: { id: { not: id } },
			data: { status: SessionStatus.DONE },
		});
		// Stops the runner mid-section and saves the doc. Keep this test last.
		closed = true;
		await ctx.close();

		const second = agentHarness();
		second.script([{ text: 'Second section, finished.' }]);
		const restarted = await setupE2E({ overrides: second.overrides });
		try {
			await waitFor(
				() =>
					testPrisma.approval.findFirst({
						where: {
							sessionId: id,
							kind: ApprovalKind.MARK_FINAL,
							status: ApprovalStatus.PENDING,
						},
					}),
				{ what: 'the restarted run to finish' },
			);
			const doc = await restarted.app.get(AgentDocWriter).listSections(id);
			expect(doc.map((s) => s.title)).toEqual(['First', 'Second']);
			expect(doc[0].text).toBe('First section text.');
			expect(doc[1].text.endsWith('Second section, finished.')).toBe(true);
			// Only the unfinished step was written again.
			expect(second.model.calls).toHaveLength(1);
			const started = await testPrisma.timelineEvent.count({
				where: { sessionId: id, type: EventType.STEP_STARTED },
			});
			expect(started).toBe(2);
		} finally {
			await restarted.close();
		}
	});
});
