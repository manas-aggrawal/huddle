import { SessionRole, SocketEvent, StepStatus } from '@huddle/shared';
import { AgentRunner } from '@src/agent/agent-runner.service';
import { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentHarness, outlineReply, waitFor } from './utils/agent';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';
import { connectSocket, waitForEvent } from './utils/socket';

const slow = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('Deleting a session', () => {
	const agent = agentHarness();
	let ctx: E2EContext<'maya' | 'leo'>;
	const sockets: Socket[] = [];

	beforeAll(async () => {
		ctx = await setupE2E({
			users: ['maya', 'leo'],
			overrides: agent.overrides,
		});
	});
	afterAll(async () => {
		for (const s of sockets) s.close();
		await ctx.close();
	});

	async function session() {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Doomed', goal: 'Compare note apps' })
			.expect(201);
		const id = res.body.id as string;
		await testPrisma.sessionMember.create({
			data: {
				sessionId: id,
				userId: ctx.users.leo.id,
				role: SessionRole.EDITOR,
			},
		});
		return id;
	}

	it('only the Owner can delete; it stops the agent, removes everything, and tells every member', async () => {
		agent.script([
			{ text: outlineReply('A') },
			{ text: slow(400), chunkDelayMs: 10 },
		]);
		const id = await session();
		const outline = await waitFor(() =>
			testPrisma.approval.findFirst({ where: { sessionId: id } }),
		);
		await ctx
			.as('maya')
			.post(`/sessions/${id}/approvals/${outline.id}`)
			.send({ decision: 'approve' })
			.expect(201);
		await waitFor(async () => {
			const step = await testPrisma.planStep.findFirst({
				where: { sessionId: id },
			});
			return step?.status === StepStatus.IN_PROGRESS;
		});
		const runner = ctx.app.get(AgentRunner);
		expect(runner.isRunning(id)).toBe(true);

		await ctx.as('leo').delete(`/sessions/${id}`).expect(403);

		const leo = await connectSocket(ctx.app, ctx.users.leo.token);
		sockets.push(leo);
		const told = waitForEvent<{ sessionId: string; reason: string }>(
			leo,
			SocketEvent.SESSION_REMOVED,
			(p) => p.sessionId === id,
		);
		await ctx.as('maya').delete(`/sessions/${id}`).expect(204);
		expect(await told).toEqual({ sessionId: id, reason: 'deleted' });
		expect(runner.isRunning(id)).toBe(false);

		const where = { where: { sessionId: id } };
		expect(await testPrisma.session.count({ where: { id } })).toBe(0);
		expect(
			await Promise.all([
				testPrisma.sessionMember.count(where),
				testPrisma.planStep.count(where),
				testPrisma.approval.count(where),
				testPrisma.timelineEvent.count(where),
				testPrisma.notification.count(where),
			]),
		).toEqual([0, 0, 0, 0, 0]);
		await ctx.as('maya').get(`/sessions/${id}`).expect(404);
		const list = (await ctx.as('leo').get('/sessions').expect(200)).body;
		expect(list.map((s: { id: string }) => s.id)).not.toContain(id);
	});

	it('a done session can be deleted too', async () => {
		agent.script([]);
		const id = await session();
		await ctx
			.as('maya')
			.patch(`/sessions/${id}/status`)
			.send({ action: 'end' })
			.expect(200);
		await ctx.as('maya').delete(`/sessions/${id}`).expect(204);
		await ctx.as('maya').delete(`/sessions/${id}`).expect(404);
	});
});
