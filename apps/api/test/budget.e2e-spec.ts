import {
	ApprovalKind,
	ApprovalStatus,
	EventType,
	SessionRole,
	SessionStatus,
	WorkspaceRole,
} from '@huddle/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

vi.hoisted(() => {
	process.env.MODELS = 'ollama:qwen2.5:14b';
});

describe('Model, effort and budgets', () => {
	const agent = agentHarness();
	let ctx: E2EContext<'maya' | 'leo'>;
	let workspaceId: string;

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo'],
			overrides: agent.overrides,
		});
		workspaceId = (
			await testPrisma.workspaceMember.findFirstOrThrow({
				where: { userId: ctx.users.maya.id },
			})
		).workspaceId;
	});
	afterAll(async () => {
		await ctx.close();
	});

	async function waitingSession(by: 'maya' | 'leo' = 'maya') {
		const res = await ctx
			.as(by)
			.post('/sessions')
			.send({ title: 'Budget', goal: 'Compare note apps', workspaceId })
			.expect(201);
		const id = res.body.id as string;
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
	const approve = (who: 'maya' | 'leo', id: string, approvalId: string) =>
		ctx
			.as(who)
			.post(`/sessions/${id}/approvals/${approvalId}`)
			.send({ decision: 'approve' })
			.expect(201);
	const settings = (who: 'maya' | 'leo', id: string, body: object) =>
		ctx.as(who).patch(`/sessions/${id}/settings`).send(body);
	const freshPool = () =>
		testPrisma.workspace.update({
			where: { id: workspaceId },
			data: { tokensUsedThisPeriod: 0, tokenAllowance: 2_000_000 },
		});

	it('only the Owner changes settings; an unlisted model is a 400', async () => {
		agent.script([{ text: outlineReply('A') }]);
		const { id } = await waitingSession();
		await testPrisma.sessionMember.create({
			data: {
				sessionId: id,
				userId: ctx.users.leo.id,
				role: SessionRole.EDITOR,
			},
		});
		await settings('leo', id, { effort: 'HIGH' }).expect(403);
		await settings('maya', id, {
			modelProvider: 'openai',
			modelId: 'gpt-9',
		}).expect(400);
		await settings('maya', id, { modelProvider: 'ollama' }).expect(400);
		const res = await settings('maya', id, {
			effort: 'HIGH',
			tokenBudget: 50_000,
		}).expect(200);
		expect(res.body).toMatchObject({ effort: 'HIGH', tokenBudget: 50_000 });
		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.MODEL_CHANGED },
		});
		expect(event.payload).toMatchObject({
			effort: 'HIGH',
			tokenBudget: 50_000,
			from: { effort: 'MEDIUM' },
		});
		await settings('maya', id, { tokenBudget: null }).expect(200);
		expect(
			(await testPrisma.session.findUniqueOrThrow({ where: { id } }))
				.tokenBudget,
		).toBeNull();
	});

	it('after a model change, the next call uses the new model and its UsageRecord says so', async () => {
		await freshPool();
		agent.script([{ text: outlineReply('A') }, { text: 'A text.' }]);
		const { id, outline } = await waitingSession();
		await settings('maya', id, {
			modelProvider: 'ollama',
			modelId: 'qwen2.5:14b',
		}).expect(200);
		await approve('maya', id, outline.id);
		await waitFor(() =>
			testPrisma.approval.findFirst({
				where: { sessionId: id, kind: ApprovalKind.MARK_FINAL },
			}),
		);
		const records = await testPrisma.usageRecord.findMany({
			where: { sessionId: id },
			orderBy: { createdAt: 'asc' },
		});
		expect(records.map((r) => `${r.purpose}:${r.provider}:${r.model}`)).toEqual(
			['outline:groq:llama-3.3-70b-versatile', 'section:ollama:qwen2.5:14b'],
		);
	});

	it('reaching the session cap asks for more (WAITING); approving raises the cap and the run finishes', async () => {
		await freshPool();
		agent.script([
			{ text: outlineReply('A', 'B'), usage: { input: 100, output: 20 } },
			{ text: 'A text.', usage: { input: 100, output: 50 } },
			{ text: 'B text.', usage: { input: 100, output: 50 } },
		]);
		const { id, outline } = await waitingSession();
		// 120 used by the outline; A fits under 121, B doesn't.
		await settings('maya', id, { tokenBudget: 121 }).expect(200);
		await approve('maya', id, outline.id);
		const gate = await waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: {
						sessionId: id,
						kind: ApprovalKind.BUDGET,
						status: ApprovalStatus.PENDING,
					},
				}),
			{ what: 'the budget approval' },
		);
		expect(gate.details).toMatchObject({ extraTokens: 200_000, budget: 121 });
		expect(
			(await testPrisma.session.findUniqueOrThrow({ where: { id } })).status,
		).toBe(SessionStatus.WAITING);

		await approve('maya', id, gate.id);
		const session = await testPrisma.session.findUniqueOrThrow({
			where: { id },
		});
		expect(session.tokenBudget).toBe(270 + 200_000);
		await waitFor(() =>
			testPrisma.approval.findFirst({
				where: { sessionId: id, kind: ApprovalKind.MARK_FINAL },
			}),
		);
		expect(
			(await testPrisma.planStep.findMany({ where: { sessionId: id } })).every(
				(s) => s.status === 'DONE',
			),
		).toBe(true);
	});

	it('an empty pool pauses every active session in the workspace and tells the admins; only an admin raises it, which resumes them', async () => {
		await freshPool();
		await testPrisma.workspaceMember.create({
			data: {
				workspaceId,
				userId: ctx.users.leo.id,
				role: WorkspaceRole.MEMBER,
			},
		});
		agent.script([
			{ text: outlineReply('A', 'B'), usage: { input: 50, output: 10 } },
			{ text: outlineReply('X'), usage: { input: 50, output: 10 } },
			{ text: 'A text.', usage: { input: 50, output: 10 } },
			{ text: 'B text.' },
		]);
		const one = await waitingSession();
		const two = await waitingSession('leo');
		const ws = await testPrisma.workspace.findUniqueOrThrow({
			where: { id: workspaceId },
		});
		// Room for one more call.
		await testPrisma.workspace.update({
			where: { id: workspaceId },
			data: { tokenAllowance: ws.tokensUsedThisPeriod + 1 },
		});
		await approve('maya', one.id, one.outline.id);

		// Every active session in the workspace is paused, one after another.
		const statusOf = async (id: string) =>
			(await testPrisma.session.findUniqueOrThrow({ where: { id } })).status;
		await waitFor(
			async () =>
				(await statusOf(one.id)) === SessionStatus.PAUSED &&
				(await statusOf(two.id)) === SessionStatus.PAUSED,
			{ what: 'both sessions to pause' },
		);
		const warning = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: one.id, type: EventType.BUDGET_WARNING },
		});
		expect(warning.payload).toMatchObject({ reason: 'pool_exhausted' });
		const notes = await testPrisma.notification.findMany({
			where: { type: 'POOL_EXHAUSTED' },
		});
		expect(notes.map((n) => n.userId)).toEqual([ctx.users.maya.id]);

		await ctx
			.as('leo')
			.patch(`/workspaces/${workspaceId}/allowance`)
			.send({ tokenAllowance: 5_000_000 })
			.expect(403);
		const usage = await ctx
			.as('leo')
			.get(`/workspaces/${workspaceId}/usage`)
			.expect(200);
		expect(usage.body.tokenAllowance).toBe(ws.tokensUsedThisPeriod + 1);

		await ctx
			.as('maya')
			.patch(`/workspaces/${workspaceId}/allowance`)
			.send({ tokenAllowance: 5_000_000 })
			.expect(200);
		expect(
			(await testPrisma.session.findUniqueOrThrow({ where: { id: one.id } }))
				.status,
		).toBe(SessionStatus.RUNNING);
		// Two was waiting on its outline when it was paused; it goes back to that.
		expect(
			(await testPrisma.session.findUniqueOrThrow({ where: { id: two.id } }))
				.status,
		).toBe(SessionStatus.WAITING);
		await waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: { sessionId: one.id, kind: ApprovalKind.MARK_FINAL },
				}),
			{
				what: 'session one to finish',
			},
		);
	});
});
