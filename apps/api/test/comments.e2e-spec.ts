import {
	ApprovalKind,
	ApprovalStatus,
	SessionRole,
	StepStatus,
} from '@huddle/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

const IDS = /id ([0-9a-f-]{36})/g;
const slow = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('Doc comments', () => {
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

	it('a Viewer’s comment is queued with its anchor, listed for everyone, and reaches the agent after suggestions', async () => {
		agent.script([
			{ text: outlineReply('A', 'B') },
			{ text: 'Notion is the best tool for everyone.' },
			{ text: slow(60), chunkDelayMs: 10 },
			{
				text: (prompt) =>
					JSON.stringify({
						decisions: [...prompt.matchAll(IDS)].map((m) => ({
							messageId: m[1],
							decision: 'apply',
							reply: 'Noted.',
						})),
					}),
			},
		]);
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Comments', goal: 'Compare note apps' })
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
		const stepB = await waitFor(async () => {
			const b = await testPrisma.planStep.findFirst({
				where: { sessionId: id, title: 'B' },
			});
			return b?.status === StepStatus.IN_PROGRESS ? b : null;
		});
		expect(stepB).toBeTruthy();
		const stepA = await testPrisma.planStep.findFirstOrThrow({
			where: { sessionId: id, title: 'A' },
		});

		const anchor = {
			sectionId: stepA.sectionId,
			quote: 'the best tool for everyone',
			from: '{"type":null}',
			to: '{"type":null}',
		};
		const comment = await ctx
			.as('dana')
			.post(`/sessions/${id}/messages`)
			.send({ mode: 'COMMENT', content: 'Be more skeptical here', anchor })
			.expect(201);
		await ctx
			.as('leo')
			.post(`/sessions/${id}/messages`)
			.send({ mode: 'SUGGEST', content: 'Add pricing tables' })
			.expect(201);

		const listed = await ctx
			.as('dana')
			.get(`/sessions/${id}/messages?mode=COMMENT`)
			.expect(200);
		expect(listed.body).toEqual([
			expect.objectContaining({
				id: comment.body.id,
				mode: 'COMMENT',
				content: 'Be more skeptical here',
				anchor,
				author: { id: ctx.users.dana.id, name: 'dana Tester' },
			}),
		]);

		await waitFor(
			async () =>
				(
					await testPrisma.message.findUniqueOrThrow({
						where: { id: comment.body.id },
					})
				).status !== 'QUEUED',
			{ what: 'the comment to be handled', timeoutMs: 8000 },
		);
		const prompt = agent.model.promptText(3);
		expect(prompt).toContain(
			'commented on \\"the best tool for everyone\\" in \\"A\\"',
		);
		// Even though the comment came first, the Editor's suggestion is listed before it.
		expect(prompt.indexOf('Add pricing tables')).toBeLessThan(
			prompt.indexOf('Be more skeptical here'),
		);
		expect(prompt).toContain('dana Tester (viewer)');
	});
});
