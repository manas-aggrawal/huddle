import {
	ApprovalKind,
	ApprovalStatus,
	EventType,
	SessionRole,
	SessionStatus,
} from '@huddle/shared';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { connectDoc, type DocClient, typeInto } from './utils/doc';
import { E2EContext, setupE2E } from './utils/setup';

const IDS = /id ([0-9a-f-]{36})/g;

describe('Mark final and Done', () => {
	const agent = agentHarness();
	let ctx: E2EContext<'maya' | 'leo'>;
	const clients: DocClient[] = [];

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo'],
			overrides: agent.overrides,
		});
	});
	afterAll(async () => {
		for (const c of clients) c.close();
		await ctx.close();
	});

	/** A session written to the end, waiting for MARK_FINAL. Leo is an Editor. */
	async function finished(extra: Parameters<typeof agent.script>[0] = []) {
		agent.script([{ text: outlineReply('A') }, { text: 'A text.' }, ...extra]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Final', goal: 'Compare note apps' })
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
		const final = await waitFor(() =>
			testPrisma.approval.findFirst({
				where: {
					sessionId: id,
					kind: ApprovalKind.MARK_FINAL,
					status: ApprovalStatus.PENDING,
				},
			}),
		);
		return { id, final };
	}

	it('approving MARK_FINAL ends the session, and the doc turns read-only even for a connected Editor', async () => {
		const { id, final } = await finished();
		const step = await testPrisma.planStep.findFirstOrThrow({
			where: { sessionId: id },
		});
		const leo = await connectDoc(ctx.app, ctx.users.leo.token, id);
		clients.push(leo);
		expect(leo.scope).toBe('read-write');

		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${final.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		const session = await testPrisma.session.findUniqueOrThrow({
			where: { id },
		});
		expect(session.status).toBe(SessionStatus.DONE);
		expect(session.completedAt).not.toBeNull();

		// Leo's connection is reset and comes back read-only.
		await waitFor(() => leo.scope === 'readonly', {
			what: 'a read-only reconnect',
		});
		typeInto(
			leo.doc,
			step.sectionId as string,
			' Sneaky edit.',
			ctx.users.leo.id,
		);
		await new Promise((r) => setTimeout(r, 300));
		expect(
			await ctx.app
				.get(AgentDocWriter)
				.getSectionText(id, step.sectionId as string),
		).toBe('A text.');

		const fresh = await connectDoc(ctx.app, ctx.users.maya.token, id);
		clients.push(fresh);
		expect(fresh.scope).toBe('readonly');
	});

	it('rejecting with a note queues it as a Suggest, and the agent goes back to work', async () => {
		const { id, final } = await finished([
			{
				text: (prompt) =>
					JSON.stringify({
						decisions: [...prompt.matchAll(IDS)].map((m) => ({
							messageId: m[1],
							decision: 'plan_change',
							reply: 'On it, Maya.',
							planOps: [{ op: 'add', title: 'Pricing table' }],
						})),
					}),
			},
			{ text: 'Pricing table text.' },
		]);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${final.id}`)
			.send({ decision: 'reject', note: 'Add a pricing table' })
			.expect(201);

		const message = await testPrisma.message.findFirstOrThrow({
			where: { sessionId: id, content: 'Add a pricing table' },
		});
		expect(message.mode).toBe('SUGGEST');
		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: {
				sessionId: id,
				type: EventType.HUMAN_MESSAGE,
				payload: { path: ['messageId'], equals: message.id },
			},
		});
		expect(event.payload).toMatchObject({
			via: 'final_rejected',
			author: { name: 'maya Tester' },
		});

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
		const steps = await testPrisma.planStep.findMany({
			where: { sessionId: id },
			orderBy: { position: 'asc' },
		});
		expect(steps.map((s) => [s.title, s.status])).toEqual([
			['A', 'DONE'],
			['Pricing table', 'DONE'],
		]);
		expect(
			(
				await testPrisma.message.findUniqueOrThrow({
					where: { id: message.id },
				})
			).status,
		).toBe('APPLIED');
	});

	it('a done session refuses instructions but still answers questions', async () => {
		const { id, final } = await finished([
			{ text: 'Because it is the most used.' },
		]);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${final.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		await ctx
			.as('leo')
			.post(`/sessions/${id}/messages`)
			.send({ mode: 'SUGGEST', content: 'more' })
			.expect(409);
		const ask = await ctx
			.as('leo')
			.post(`/sessions/${id}/messages`)
			.send({ mode: 'ASK', content: 'Why A?' })
			.expect(201);
		await waitFor(
			async () =>
				(
					await testPrisma.message.findUniqueOrThrow({
						where: { id: ask.body.id },
					})
				).status === 'ANSWERED',
		);
	});
});
