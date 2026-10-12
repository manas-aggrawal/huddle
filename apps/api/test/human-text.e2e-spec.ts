import {
	ApprovalKind,
	ApprovalStatus,
	SessionRole,
	StepStatus,
} from '@huddle/shared';
import {
	AgentDocWriter,
	HumanTextProtectedError,
} from '@src/collab/agent-doc-writer.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { connectDoc, type DocClient, typeInto, typeSection } from './utils/doc';
import { E2EContext, setupE2E } from './utils/setup';

const MESSAGE_ID = /id ([0-9a-f-]{36})/;
const slow = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('Protecting human-written text', () => {
	const agent = agentHarness();
	let ctx: E2EContext<'maya' | 'leo'>;
	let writer: AgentDocWriter;
	const clients: DocClient[] = [];

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo'],
			overrides: agent.overrides,
		});
		writer = ctx.app.get(AgentDocWriter);
	});
	afterAll(async () => {
		for (const c of clients) c.close();
		await ctx.close();
	});

	/** A session parked in DONE so the agent leaves its doc alone. */
	async function quietSession() {
		agent.script([{ text: outlineReply('Unused') }]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Doc', goal: 'g' })
			.expect(201);
		await waitFor(() =>
			testPrisma.approval.findFirst({ where: { sessionId: res.body.id } }),
		);
		await testPrisma.session.update({
			where: { id: res.body.id },
			data: { status: 'DONE' },
		});
		return res.body.id as string;
	}

	async function leoTypes(
		sessionId: string,
		sectionId: string,
		title: string,
		text: string,
	) {
		const client = await connectDoc(ctx.app, ctx.users.maya.token, sessionId);
		clients.push(client);
		typeSection(client.doc, sectionId, title, text, ctx.users.leo.id);
		await waitFor(async () =>
			(await writer.listSections(sessionId)).some((s) => s.text === text),
		);
		return client;
	}

	it('the agent can’t replace a person’s text: the write throws and the doc is unchanged', async () => {
		const id = await quietSession();
		await leoTypes(id, 's-a', 'A', 'Notion is the best tool.');

		await expect(
			writer.replaceText(id, 's-a', 'the best tool', 'a decent tool'),
		).rejects.toBeInstanceOf(HumanTextProtectedError);
		expect(await writer.getSectionText(id, 's-a')).toBe(
			'Notion is the best tool.',
		);
		expect(await writer.getHumanOwnedRanges(id, 's-a')).toEqual([
			expect.objectContaining({
				userId: ctx.users.leo.id,
				text: 'Notion is the best tool.',
			}),
		]);
	});

	it('appending after a person’s paragraph is fine', async () => {
		const id = await quietSession();
		await leoTypes(id, 's-b', 'B', 'Leo wrote this.');
		await writer.appendToSection(id, 's-b', '\n\nThe agent adds this.');
		expect(await writer.getSectionText(id, 's-b')).toBe(
			'Leo wrote this.\n\nThe agent adds this.',
		);
		const ranges = await writer.getHumanOwnedRanges(id, 's-b');
		expect(ranges.map((r) => r.text)).toEqual(['Leo wrote this.']);
	});

	it('the agent can change its own text directly', async () => {
		const id = await quietSession();
		await writer.insertSection(id, 's-c', 'C');
		await writer.appendToSection(id, 's-c', 'Agent says Notion is great.');
		await writer.replaceText(id, 's-c', 'is great', 'is popular');
		expect(await writer.getSectionText(id, 's-c')).toBe(
			'Agent says Notion is popular.',
		);
	});

	/**
	 * Runs a session with sections A and B. While B is written, Leo adds his
	 * own sentence to A and suggests rewording it; the agent proposes a rewrite.
	 */
	async function rewriteRequested() {
		agent.script([
			{ text: outlineReply('A', 'B') },
			{ text: 'Agent intro.' },
			{ text: slow(80), chunkDelayMs: 10 },
			{
				text: (prompt) =>
					JSON.stringify({
						decisions: [
							{
								messageId: prompt.match(MESSAGE_ID)?.[1],
								decision: 'apply',
								reply: 'Sure Leo.',
								rewrite: {
									position: 1,
									before: 'Notion is the best tool.',
									after: 'Notion may be a good tool.',
								},
							},
						],
					}),
			},
		]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Rewrite', goal: 'g' })
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
				where: { sessionId: id, kind: ApprovalKind.OUTLINE },
			}),
		);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${outline.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		const stepB = await waitFor(async () => {
			const s = await testPrisma.planStep.findFirst({
				where: { sessionId: id, title: 'B' },
			});
			return s?.status === StepStatus.IN_PROGRESS ? s : null;
		});
		expect(stepB).toBeTruthy();
		const stepA = await testPrisma.planStep.findFirstOrThrow({
			where: { sessionId: id, title: 'A' },
		});

		const client = await connectDoc(ctx.app, ctx.users.leo.token, id);
		clients.push(client);
		typeInto(
			client.doc,
			stepA.sectionId as string,
			' Notion is the best tool.',
			ctx.users.leo.id,
		);
		await waitFor(async () =>
			(await writer.getSectionText(id, stepA.sectionId as string)).includes(
				'best tool',
			),
		);
		await ctx
			.as('leo')
			.post(`/sessions/${id}/messages`)
			.send({ mode: 'SUGGEST', content: 'Make A more skeptical' })
			.expect(201);

		const approval = await waitFor(
			() =>
				testPrisma.approval.findFirst({
					where: {
						sessionId: id,
						kind: ApprovalKind.REWRITE_HUMAN_TEXT,
						status: ApprovalStatus.PENDING,
					},
				}),
			{ what: 'the rewrite approval', timeoutMs: 8000 },
		);
		return { id, approval, sectionId: stepA.sectionId as string };
	}

	it('a rewrite of human text asks first; approving it applies the change', async () => {
		const { id, approval, sectionId } = await rewriteRequested();
		expect(approval.details).toMatchObject({
			sectionId,
			before: 'Notion is the best tool.',
			after: 'Notion may be a good tool.',
			authors: ['leo Tester'],
		});
		// Still the original until someone approves.
		expect(await writer.getSectionText(id, sectionId)).toContain(
			'Notion is the best tool.',
		);
		// The reply is saved right after the approval is requested.
		await waitFor(
			async () =>
				(
					await testPrisma.message.findFirstOrThrow({
						where: { sessionId: id, mode: 'SUGGEST' },
					})
				).status === 'ACKNOWLEDGED',
			{ what: 'the suggestion to be acknowledged' },
		);

		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${approval.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		await waitFor(async () =>
			(await writer.getSectionText(id, sectionId)).includes(
				'Notion may be a good tool.',
			),
		);
		const text = await writer.getSectionText(id, sectionId);
		expect(text).not.toContain('best tool');
		// The new words are the agent's: no longer marked as Leo's.
		const ranges = await writer.getHumanOwnedRanges(id, sectionId);
		expect(ranges.some((r) => r.text.includes('good tool'))).toBe(false);
	});

	it('rejecting the rewrite leaves the doc unchanged', async () => {
		const { id, approval, sectionId } = await rewriteRequested();
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${approval.id}`)
			.send({ decision: 'reject' })
			.expect(201);
		await new Promise((r) => setTimeout(r, 300));
		expect(await writer.getSectionText(id, sectionId)).toContain(
			'Notion is the best tool.',
		);
	});
});
