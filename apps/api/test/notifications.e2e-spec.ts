import { ApprovalKind, SessionRole, SocketEvent } from '@huddle/shared';
import { ApprovalService } from '@src/approval/approval.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';
import { connectSocket, expectNoEvent, waitForEvent } from './utils/socket';

describe('Inbox and Home', () => {
	let ctx: E2EContext<'maya' | 'leo'>;
	const sockets: Socket[] = [];

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo'] });
	});
	afterAll(async () => {
		for (const s of sockets) s.close();
		await ctx.close();
	});

	async function session() {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Inbox', goal: 'g' })
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
	const requestApproval = (id: string) =>
		ctx.app.get(TimelineService).transaction((tx) =>
			ctx.app.get(ApprovalService).request(tx, id, {
				kind: ApprovalKind.MARK_FINAL,
				title: 'Mark the document final',
			}),
		);

	it('an approval request lands in the right person’s unread inbox, live', async () => {
		const id = await session();
		const maya = await connectSocket(ctx.app, ctx.users.maya.token);
		const leo = await connectSocket(ctx.app, ctx.users.leo.token);
		sockets.push(maya, leo);
		const pushed = waitForEvent<{ type: string; sessionId: string }>(
			maya,
			SocketEvent.NOTIFICATION_NEW,
		);
		const approval = await requestApproval(id);
		expect(await pushed).toMatchObject({
			type: 'APPROVAL_REQUESTED',
			sessionId: id,
			refId: approval.id,
		});
		await expectNoEvent(leo, SocketEvent.NOTIFICATION_NEW, 200);

		const unread = await ctx
			.as('maya')
			.get('/notifications?unread=true')
			.expect(200);
		expect(unread.body[0]).toMatchObject({
			sessionId: id,
			sessionTitle: 'Inbox',
			type: 'APPROVAL_REQUESTED',
			title: 'Approval needed: Mark the document final',
			readAt: null,
		});
		expect(
			(await ctx.as('leo').get('/notifications?unread=true').expect(200)).body,
		).toEqual([]);
	});

	it('reading one removes it from the unread list; someone else’s is a 404', async () => {
		await requestApproval(await session());
		const [first] = (
			await ctx.as('maya').get('/notifications?unread=true').expect(200)
		).body;
		await ctx.as('leo').post(`/notifications/${first.id}/read`).expect(404);
		await ctx.as('maya').post(`/notifications/${first.id}/read`).expect(204);
		const unread = (
			await ctx.as('maya').get('/notifications?unread=true').expect(200)
		).body;
		expect(unread.map((n: { id: string }) => n.id)).not.toContain(first.id);
		const all = (await ctx.as('maya').get('/notifications').expect(200)).body;
		expect(
			all.find((n: { id: string }) => n.id === first.id).readAt,
		).not.toBeNull();
		await ctx.as('maya').post('/notifications/read-all').expect(204);
		expect(
			(await ctx.as('maya').get('/notifications?unread=true').expect(200)).body,
		).toEqual([]);
	});

	it('the sessions list says which ones are waiting on you, with the Owner and members', async () => {
		const id = await session();
		await requestApproval(id);
		const mine = (await ctx.as('maya').get('/sessions').expect(200)).body.find(
			(s: { id: string }) => s.id === id,
		);
		expect(mine).toMatchObject({
			waitingOnMe: true,
			owner: { id: ctx.users.maya.id, name: 'maya Tester' },
			memberPreview: [
				{ userId: ctx.users.maya.id, name: 'maya Tester' },
				{ userId: ctx.users.leo.id, name: 'leo Tester' },
			],
		});
		const leos = (await ctx.as('leo').get('/sessions').expect(200)).body.find(
			(s: { id: string }) => s.id === id,
		);
		expect(leos.waitingOnMe).toBe(false);
	});
});
