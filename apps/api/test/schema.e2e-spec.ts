// Database rules and the timeline helper (#4). Fixtures are written straight to
// the database because the endpoints that create sessions arrive in #5.
import { EventType, SessionRole } from '@huddle/shared';
import { TimelineService } from '@src/timeline/timeline.service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

describe('schema rules and timeline', () => {
	let ctx: E2EContext<'maya' | 'leo' | 'dana'>;
	let timeline: TimelineService;

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo', 'dana'] });
		timeline = ctx.app.get(TimelineService);
	});
	afterAll(async () => {
		await ctx.close();
	});

	/** A session in Maya's personal workspace, with Maya as Owner. */
	async function newSession(title = 'Competitive analysis') {
		const membership = await testPrisma.workspaceMember.findFirstOrThrow({
			where: { userId: ctx.users.maya.id },
		});
		return testPrisma.session.create({
			data: {
				workspaceId: membership.workspaceId,
				title,
				goal: 'Compare the top 5 note-taking apps',
				modelId: 'openai/gpt-oss-120b',
				members: {
					create: { userId: ctx.users.maya.id, role: SessionRole.OWNER },
				},
			},
		});
	}

	function addMember(
		sessionId: string,
		userId: string,
		role: string,
		canApprove = false,
	) {
		return testPrisma.sessionMember.create({
			data: { sessionId, userId, role, canApprove },
		});
	}

	describe('one Owner per session', () => {
		it('rejects a second Owner', async () => {
			const s = await newSession();
			await expect(
				addMember(s.id, ctx.users.leo.id, SessionRole.OWNER),
			).rejects.toThrow(/Unique constraint/);
		});

		it('allows one Owner in each of two sessions, and many Editors', async () => {
			const a = await newSession('A');
			const b = await newSession('B');
			await addMember(a.id, ctx.users.leo.id, SessionRole.EDITOR);
			await addMember(a.id, ctx.users.dana.id, SessionRole.EDITOR);
			await addMember(b.id, ctx.users.leo.id, SessionRole.EDITOR);
			expect(
				await testPrisma.sessionMember.count({ where: { sessionId: a.id } }),
			).toBe(3);
		});
	});

	describe('"allowed to approve" is Editor-only', () => {
		it('rejects it on a Viewer', async () => {
			const s = await newSession();
			await expect(
				addMember(s.id, ctx.users.dana.id, SessionRole.VIEWER, true),
			).rejects.toThrow(/can_approve_only_editors/);
		});

		it('rejects it on the Owner', async () => {
			const s = await newSession();
			await expect(
				testPrisma.sessionMember.updateMany({
					where: { sessionId: s.id, role: SessionRole.OWNER },
					data: { canApprove: true },
				}),
			).rejects.toThrow(/can_approve_only_editors/);
		});

		it('accepts it on an Editor', async () => {
			const s = await newSession();
			const m = await addMember(
				s.id,
				ctx.users.leo.id,
				SessionRole.EDITOR,
				true,
			);
			expect(m.canApprove).toBe(true);
		});
	});

	describe('a decision has at most one origin', () => {
		it('rejects a decision linked to both a conflict and an approval', async () => {
			const s = await newSession();
			const conflict = await testPrisma.conflict.create({
				data: { sessionId: s.id, summary: 'Keep or drop Evernote' },
			});
			const approval = await testPrisma.approval.create({
				data: {
					sessionId: s.id,
					kind: 'OUTLINE',
					title: 'Approve the outline',
				},
			});
			await expect(
				testPrisma.decision.create({
					data: {
						sessionId: s.id,
						content: 'Keep Evernote, shortened',
						conflictId: conflict.id,
						approvalId: approval.id,
					},
				}),
			).rejects.toThrow(/decision_single_origin/);
		});

		it('accepts one origin, or none (typed by hand)', async () => {
			const s = await newSession();
			const conflict = await testPrisma.conflict.create({
				data: { sessionId: s.id, summary: 'Keep or drop Evernote' },
			});
			await testPrisma.decision.create({
				data: {
					sessionId: s.id,
					content: 'From conflict',
					conflictId: conflict.id,
				},
			});
			await testPrisma.decision.create({
				data: { sessionId: s.id, content: 'Typed by hand' },
			});
			expect(
				await testPrisma.decision.count({ where: { sessionId: s.id } }),
			).toBe(2);
		});
	});

	describe('timeline numbering', () => {
		const event = (n: number) => ({
			type: EventType.AGENT_MESSAGE,
			actorType: 'AGENT' as const,
			payload: { text: `event ${n}` },
		});

		it('gives 50 simultaneous events the numbers 1 to 50, with no gaps or repeats', async () => {
			const s = await newSession();
			const created = await Promise.all(
				Array.from({ length: 50 }, (_, i) => timeline.record(s.id, event(i))),
			);
			const seqs = created.map((e) => e.seq).sort((a, b) => a - b);
			expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
			const after = await testPrisma.session.findUniqueOrThrow({
				where: { id: s.id },
			});
			expect(after.lastEventSeq).toBe(50);
		});

		it('numbers each session separately', async () => {
			const a = await newSession('A');
			const b = await newSession('B');
			await timeline.record(a.id, event(1));
			await timeline.record(a.id, event(2));
			const first = await timeline.record(b.id, event(1));
			expect(first.seq).toBe(1);
		});

		it('leaves no gap when the surrounding transaction rolls back', async () => {
			const s = await newSession();
			await timeline.record(s.id, event(1));
			await expect(
				timeline.transaction(async (tx) => {
					await timeline.append(tx, s.id, event(2));
					throw new Error('the change this event describes failed');
				}),
			).rejects.toThrow(/failed/);
			const next = await timeline.record(s.id, event(3));
			expect(next.seq).toBe(2);
		});

		it('records the actor and payload, and refuses an unknown session', async () => {
			const s = await newSession();
			const e = await timeline.record(s.id, {
				type: EventType.SESSION_CREATED,
				actorType: 'USER',
				actorId: ctx.users.maya.id,
				payload: { title: s.title },
			});
			expect(e).toMatchObject({
				actorId: ctx.users.maya.id,
				payload: { title: s.title },
			});
			await expect(
				timeline.record('00000000-0000-0000-0000-000000000000', event(1)),
			).rejects.toThrow(/Session not found/);
		});
	});

	it('deleting a session deletes its members, events, messages and plan steps', async () => {
		const s = await newSession();
		await addMember(s.id, ctx.users.leo.id, SessionRole.EDITOR);
		await timeline.record(s.id, event());
		await testPrisma.planStep.create({
			data: { sessionId: s.id, position: 1, title: 'Outline' },
		});
		await testPrisma.message.create({
			data: {
				sessionId: s.id,
				authorId: ctx.users.leo.id,
				mode: 'SUGGEST',
				content: 'Add UX notes',
			},
		});

		await testPrisma.session.delete({ where: { id: s.id } });

		const where = { sessionId: s.id };
		expect(await testPrisma.sessionMember.count({ where })).toBe(0);
		expect(await testPrisma.timelineEvent.count({ where })).toBe(0);
		expect(await testPrisma.planStep.count({ where })).toBe(0);
		expect(await testPrisma.message.count({ where })).toBe(0);
		// The people themselves are untouched.
		expect(await testPrisma.user.count()).toBe(3);

		function event() {
			return {
				type: EventType.SESSION_CREATED,
				actorType: 'SYSTEM' as const,
				payload: {},
			};
		}
	});
});
