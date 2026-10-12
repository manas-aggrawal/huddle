import {
	ApprovalKind,
	EventType,
	SessionRole,
	SessionStatus,
} from '@huddle/shared';
import { ApprovalService } from '@src/approval/approval.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

describe('Approval gates', () => {
	let ctx: E2EContext<'maya' | 'leo' | 'raj' | 'dana'>;
	let approvals: ApprovalService;
	let timeline: TimelineService;

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo', 'raj', 'dana'] });
		approvals = ctx.app.get(ApprovalService);
		timeline = ctx.app.get(TimelineService);
	});
	afterAll(async () => {
		await ctx.close();
	});

	/** Maya's session with Leo and Raj as Editors (Raj can approve) and Dana as Viewer. */
	async function session(status: SessionStatus = SessionStatus.RUNNING) {
		const res = await ctx
			.as('maya')
			.post('/sessions')
			.send({ title: 'Gates', goal: 'g' })
			.expect(201);
		const id = res.body.id as string;
		await testPrisma.session.update({ where: { id }, data: { status } });
		await testPrisma.sessionMember.createMany({
			data: [
				{ sessionId: id, userId: ctx.users.leo.id, role: SessionRole.EDITOR },
				{
					sessionId: id,
					userId: ctx.users.raj.id,
					role: SessionRole.EDITOR,
					canApprove: true,
				},
				{ sessionId: id, userId: ctx.users.dana.id, role: SessionRole.VIEWER },
			],
		});
		return id;
	}

	const request = (
		sessionId: string,
		kind: ApprovalKind = ApprovalKind.MARK_FINAL,
	) =>
		timeline.transaction((tx) =>
			approvals.request(tx, sessionId, {
				kind,
				title: 'Mark the document final',
			}),
		);
	const resolve = (
		who: 'maya' | 'leo' | 'raj' | 'dana',
		sessionId: string,
		approvalId: string,
		body: object = { decision: 'approve' },
	) =>
		ctx
			.as(who)
			.post(`/sessions/${sessionId}/approvals/${approvalId}`)
			.send(body);
	const statusOf = async (id: string) =>
		(await testPrisma.session.findUniqueOrThrow({ where: { id } })).status;

	it('the Owner approves: status moves on and APPROVAL_RESOLVED names who did it', async () => {
		const id = await session();
		const a = await request(id, ApprovalKind.OUTLINE);
		expect(await statusOf(id)).toBe(SessionStatus.WAITING);

		const res = await resolve('maya', id, a.id).expect(201);
		expect(res.body).toMatchObject({
			status: 'APPROVED',
			resolvedById: ctx.users.maya.id,
		});
		expect(await statusOf(id)).toBe(SessionStatus.RUNNING);
		const event = await testPrisma.timelineEvent.findFirstOrThrow({
			where: { sessionId: id, type: EventType.APPROVAL_RESOLVED },
		});
		expect(event.payload).toMatchObject({
			approvalId: a.id,
			status: 'APPROVED',
			resolvedBy: { id: ctx.users.maya.id, name: 'maya Tester' },
		});
	});

	it('an Editor without canApprove gets 403, and succeeds once the Owner grants it', async () => {
		const id = await session();
		const a = await request(id, ApprovalKind.OUTLINE);
		await resolve('leo', id, a.id).expect(403);
		await resolve('dana', id, a.id).expect(403);
		await ctx
			.as('maya')
			.patch(`/sessions/${id}/members/${ctx.users.leo.id}`)
			.send({ canApprove: true })
			.expect(200);
		await resolve('leo', id, a.id).expect(201);
	});

	it('two approvers at once: one wins, the other gets 409', async () => {
		const id = await session();
		const a = await request(id, ApprovalKind.OUTLINE);
		const results = await Promise.all([
			resolve('maya', id, a.id),
			resolve('raj', id, a.id),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
		expect(
			await testPrisma.timelineEvent.count({
				where: { sessionId: id, type: EventType.APPROVAL_RESOLVED },
			}),
		).toBe(1);
	});

	it('a failed approval write leaves the status unchanged', async () => {
		const id = await session();
		await expect(
			timeline.transaction(async (tx) => {
				await approvals.request(tx, id, {
					kind: ApprovalKind.OUTLINE,
					title: 'Approve the outline',
				});
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		expect(await statusOf(id)).toBe(SessionStatus.RUNNING);
		expect(await testPrisma.approval.count({ where: { sessionId: id } })).toBe(
			0,
		);
	});

	it('notifies the Owner and Editors who can approve, and no one else', async () => {
		const id = await session();
		const a = await request(id);
		const notified = await testPrisma.notification.findMany({
			where: { refId: a.id, type: 'APPROVAL_REQUESTED' },
		});
		expect(notified.map((n) => n.userId).sort()).toEqual(
			[ctx.users.maya.id, ctx.users.raj.id].sort(),
		);
	});

	it('a rejected outline sends the session back to PLANNING with the note', async () => {
		const id = await session(SessionStatus.PLANNING);
		const a = await request(id, ApprovalKind.OUTLINE);
		await resolve('maya', id, a.id, {
			decision: 'reject',
			note: 'Add Bear',
		}).expect(201);
		expect(await statusOf(id)).toBe(SessionStatus.PLANNING);
		expect(
			(await testPrisma.approval.findUniqueOrThrow({ where: { id: a.id } }))
				.note,
		).toBe('Add Bear');
	});

	it('a step gate doesn’t stop the session; rejecting it skips the step', async () => {
		const id = await session();
		const step = await testPrisma.planStep.create({
			data: {
				sessionId: id,
				position: 1,
				title: 'Risky',
				requiresApproval: true,
			},
		});
		const a = await timeline.transaction((tx) =>
			approvals.request(tx, id, {
				kind: ApprovalKind.CUSTOM,
				title: 'Start “Risky”?',
				planStepId: step.id,
			}),
		);
		expect(await statusOf(id)).toBe(SessionStatus.RUNNING);
		await resolve('maya', id, a.id, { decision: 'reject' }).expect(201);
		expect(
			(await testPrisma.planStep.findUniqueOrThrow({ where: { id: step.id } }))
				.status,
		).toBe('SKIPPED');
		expect(await statusOf(id)).toBe(SessionStatus.RUNNING);
	});

	it('rejecting the final draft needs a note; approving it ends the session', async () => {
		const id = await session();
		const a = await request(id, ApprovalKind.MARK_FINAL);
		await resolve('maya', id, a.id, { decision: 'reject' }).expect(400);
		await resolve('maya', id, a.id).expect(201);
		const s = await testPrisma.session.findUniqueOrThrow({ where: { id } });
		expect(s.status).toBe(SessionStatus.DONE);
		expect(s.completedAt).not.toBeNull();
	});

	it('an unknown approval is 404; an answered one is 409', async () => {
		const id = await session();
		const a = await request(id, ApprovalKind.OUTLINE);
		await resolve('maya', id, '00000000-0000-4000-8000-000000000000').expect(
			404,
		);
		await resolve('maya', id, a.id).expect(201);
		await resolve('maya', id, a.id).expect(409);
	});
});
