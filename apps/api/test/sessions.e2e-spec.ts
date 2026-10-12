import { SessionRole } from '@huddle/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';

describe('Sessions API', () => {
	let ctx: E2EContext<'maya' | 'leo' | 'dana' | 'outsider'>;

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo', 'dana', 'outsider'] });
	});
	afterAll(async () => {
		await ctx.close();
	});

	const body = (over: Record<string, unknown> = {}) => ({
		title: 'Competitive analysis',
		goal: 'Compare the top 5 note-taking apps',
		...over,
	});

	/** Maya creates a session; optionally adds Leo as Editor and Dana as Viewer (invites arrive in #6). */
	async function mayaSession(withTeam = false) {
		const res = await ctx.as('maya').post('/sessions').send(body()).expect(201);
		if (withTeam) {
			await testPrisma.sessionMember.createMany({
				data: [
					{
						sessionId: res.body.id,
						userId: ctx.users.leo.id,
						role: SessionRole.EDITOR,
					},
					{
						sessionId: res.body.id,
						userId: ctx.users.dana.id,
						role: SessionRole.VIEWER,
					},
				],
			});
		}
		return res.body;
	}

	async function personalWorkspaceOf(userId: string) {
		const m = await testPrisma.workspaceMember.findFirstOrThrow({
			where: { userId },
		});
		return m.workspaceId;
	}

	describe('POST /sessions', () => {
		it('makes the creator Owner, starts in PLANNING, and writes SESSION_CREATED as event #1', async () => {
			const res = await ctx
				.as('maya')
				.post('/sessions')
				.send(body({ effort: 'HIGH', tokenBudget: 200000 }))
				.expect(201);

			expect(res.body).toMatchObject({
				title: 'Competitive analysis',
				status: 'PLANNING',
				agentState: 'IDLE',
				effort: 'HIGH',
				tokenBudget: 200000,
				tokensUsed: 0,
				lastEventSeq: 1,
				// Defaults from DEFAULT_MODEL_PROVIDER / DEFAULT_MODEL_ID
				modelProvider: 'groq',
				modelId: 'openai/gpt-oss-120b',
				completedAt: null,
			});

			const members = await testPrisma.sessionMember.findMany({
				where: { sessionId: res.body.id },
			});
			expect(members).toEqual([
				expect.objectContaining({ userId: ctx.users.maya.id, role: 'OWNER' }),
			]);

			const events = await testPrisma.timelineEvent.findMany({
				where: { sessionId: res.body.id },
			});
			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({
				seq: 1,
				type: 'SESSION_CREATED',
				actorType: 'USER',
				actorId: ctx.users.maya.id,
				payload: {
					actor: { id: ctx.users.maya.id, name: 'maya Tester' },
					title: 'Competitive analysis',
				},
			});
		});

		it("goes into the creator's personal workspace when none is given", async () => {
			const s = await mayaSession();
			expect(s.workspaceId).toBe(await personalWorkspaceOf(ctx.users.maya.id));
		});

		it('accepts a workspace the caller belongs to', async () => {
			const ws = await personalWorkspaceOf(ctx.users.maya.id);
			const res = await ctx
				.as('maya')
				.post('/sessions')
				.send(body({ workspaceId: ws }))
				.expect(201);
			expect(res.body.workspaceId).toBe(ws);
		});

		it("returns 403 for a workspace the caller doesn't belong to", async () => {
			const mayasWorkspace = await personalWorkspaceOf(ctx.users.maya.id);
			await ctx
				.as('outsider')
				.post('/sessions')
				.send(body({ workspaceId: mayasWorkspace }))
				.expect(403);
		});

		it('rejects an empty goal and a title over 200 characters with zod details', async () => {
			const empty = await ctx
				.as('maya')
				.post('/sessions')
				.send(body({ goal: '   ' }))
				.expect(400);
			expect(JSON.stringify(empty.body)).toContain('goal');
			const long = await ctx
				.as('maya')
				.post('/sessions')
				.send(body({ title: 'x'.repeat(201) }))
				.expect(400);
			expect(JSON.stringify(long.body)).toContain('title');
		});

		it('rejects values outside the shared lists (no DB enums, so this check is what protects the data)', async () => {
			const res = await ctx
				.as('maya')
				.post('/sessions')
				.send(body({ effort: 'EXTREME' }))
				.expect(400);
			expect(JSON.stringify(res.body)).toContain('effort');
		});
	});

	describe('GET /sessions', () => {
		it("returns only the caller's sessions, with their role and the member count", async () => {
			const s = await mayaSession(true);
			const leos = await ctx.as('leo').get('/sessions').expect(200);
			const mine = leos.body.find((x: { id: string }) => x.id === s.id);
			expect(mine).toMatchObject({ myRole: 'EDITOR', memberCount: 3 });

			const outsiders = await ctx.as('outsider').get('/sessions').expect(200);
			expect(outsiders.body).toEqual([]);
		});

		it('filters by status, and rejects a status that does not exist', async () => {
			const s = await mayaSession();
			await ctx
				.as('maya')
				.patch(`/sessions/${s.id}/status`)
				.send({ action: 'pause' })
				.expect(200);

			const paused = await ctx
				.as('maya')
				.get('/sessions?status=PAUSED')
				.expect(200);
			expect(paused.body.map((x: { id: string }) => x.id)).toEqual([s.id]);

			await ctx.as('maya').get('/sessions?status=BOGUS').expect(400);
		});
	});

	describe('GET /sessions/:id', () => {
		it('returns members with roles, the plan and pending approvals to a member', async () => {
			const s = await mayaSession(true);
			await testPrisma.planStep.create({
				data: { sessionId: s.id, position: 1, title: 'Market overview' },
			});
			await testPrisma.approval.create({
				data: {
					sessionId: s.id,
					kind: 'OUTLINE',
					title: 'Approve the outline',
				},
			});

			const res = await ctx.as('dana').get(`/sessions/${s.id}`).expect(200);
			expect(res.body.myRole).toBe('VIEWER');
			expect(res.body.members.map((m: { role: string }) => m.role)).toEqual([
				'OWNER',
				'EDITOR',
				'VIEWER',
			]);
			expect(res.body.planSteps).toEqual([
				expect.objectContaining({
					title: 'Market overview',
					status: 'PENDING',
				}),
			]);
			expect(res.body.pendingApprovals).toEqual([
				expect.objectContaining({
					kind: 'OUTLINE',
					title: 'Approve the outline',
				}),
			]);
		});

		it('returns 404 to a non-member, the same as for a session that does not exist', async () => {
			const s = await mayaSession();
			await ctx.as('outsider').get(`/sessions/${s.id}`).expect(404);
			await ctx
				.as('outsider')
				.get('/sessions/00000000-0000-0000-0000-000000000000')
				.expect(404);
			await ctx.as('outsider').get('/sessions/not-a-uuid').expect(404);
		});
	});

	describe('PATCH /sessions/:id/status', () => {
		it('returns 403 to an Editor and a Viewer', async () => {
			const s = await mayaSession(true);
			await ctx
				.as('leo')
				.patch(`/sessions/${s.id}/status`)
				.send({ action: 'pause' })
				.expect(403);
			await ctx
				.as('dana')
				.patch(`/sessions/${s.id}/status`)
				.send({ action: 'end' })
				.expect(403);
		});

		it('lets the Owner pause, resume and end, writing an event for each', async () => {
			const s = await mayaSession();
			const status = (action: string) =>
				ctx
					.as('maya')
					.patch(`/sessions/${s.id}/status`)
					.send({ action })
					.expect(200);

			expect((await status('pause')).body.status).toBe('PAUSED');
			// No plan yet, so resuming returns to PLANNING.
			expect((await status('resume')).body.status).toBe('PLANNING');
			const ended = (await status('end')).body;
			expect(ended.status).toBe('DONE');
			expect(ended.completedAt).toEqual(expect.any(String));

			const events = await testPrisma.timelineEvent.findMany({
				where: { sessionId: s.id, type: 'STATUS_CHANGED' },
				orderBy: { seq: 'asc' },
			});
			expect(events.map((e) => e.payload)).toEqual([
				expect.objectContaining({
					action: 'pause',
					from: 'PLANNING',
					to: 'PAUSED',
				}),
				expect.objectContaining({
					action: 'resume',
					from: 'PAUSED',
					to: 'PLANNING',
				}),
				expect.objectContaining({
					action: 'end',
					from: 'PLANNING',
					to: 'DONE',
				}),
			]);
			expect(events.map((e) => e.seq)).toEqual([2, 3, 4]);
		});

		it('resumes to WAITING when a blocking approval is pending, and to RUNNING when the plan exists', async () => {
			const s = await mayaSession();
			await testPrisma.planStep.create({
				data: { sessionId: s.id, position: 1, title: 'Notion' },
			});
			const status = (action: string) =>
				ctx
					.as('maya')
					.patch(`/sessions/${s.id}/status`)
					.send({ action })
					.expect(200);

			await status('pause');
			expect((await status('resume')).body.status).toBe('RUNNING');

			await testPrisma.approval.create({
				data: {
					sessionId: s.id,
					kind: 'MARK_FINAL',
					title: 'Mark the document final',
				},
			});
			await status('pause');
			expect((await status('resume')).body.status).toBe('WAITING');
		});

		it('returns 409 for changes that make no sense', async () => {
			const s = await mayaSession();
			const status = (action: string) =>
				ctx.as('maya').patch(`/sessions/${s.id}/status`).send({ action });

			await status('resume').expect(409); // not paused
			await status('end').expect(200);
			await status('pause').expect(409); // already done
			await status('end').expect(409);
		});

		it('rejects an unknown action', async () => {
			const s = await mayaSession();
			await ctx
				.as('maya')
				.patch(`/sessions/${s.id}/status`)
				.send({ action: 'explode' })
				.expect(400);
		});
	});

	it('returns 401 on every session endpoint without a token', async () => {
		const s = await mayaSession();
		await ctx.http.post('/sessions').send(body()).expect(401);
		await ctx.http.get('/sessions').expect(401);
		await ctx.http.get(`/sessions/${s.id}`).expect(401);
		await ctx.http
			.patch(`/sessions/${s.id}/status`)
			.send({ action: 'pause' })
			.expect(401);
	});
	describe('creating with context and a model (#11)', () => {
		it('saves context as one QUEUED Suggest from the creator, plus a HUMAN_MESSAGE event #2', async () => {
			const res = await ctx
				.as('maya')
				.post('/sessions')
				.send(
					body({
						context: '  Focus on pricing. See https://obsidian.md/pricing  ',
					}),
				)
				.expect(201);
			expect(res.body.lastEventSeq).toBe(2);

			const messages = await testPrisma.message.findMany({
				where: { sessionId: res.body.id },
			});
			expect(messages).toEqual([
				expect.objectContaining({
					authorId: ctx.users.maya.id,
					mode: 'SUGGEST',
					status: 'QUEUED',
					content: 'Focus on pricing. See https://obsidian.md/pricing',
				}),
			]);

			const events = await testPrisma.timelineEvent.findMany({
				where: { sessionId: res.body.id },
				orderBy: { seq: 'asc' },
			});
			expect(events.map((e) => [e.seq, e.type])).toEqual([
				[1, 'SESSION_CREATED'],
				[2, 'HUMAN_MESSAGE'],
			]);
			expect(events[1].payload).toMatchObject({
				messageId: messages[0].id,
				mode: 'SUGGEST',
				content: 'Focus on pricing. See https://obsidian.md/pricing',
				author: { id: ctx.users.maya.id, role: 'OWNER' },
			});
		});

		it('creates no message for missing or blank context', async () => {
			for (const context of [undefined, '   ']) {
				const res = await ctx
					.as('maya')
					.post('/sessions')
					.send(body({ context }))
					.expect(201);
				expect(
					await testPrisma.message.count({ where: { sessionId: res.body.id } }),
				).toBe(0);
				expect(res.body.lastEventSeq).toBe(1);
			}
		});

		it('rejects context over 10,000 characters, and writes nothing', async () => {
			const before = await testPrisma.session.count();
			await ctx
				.as('maya')
				.post('/sessions')
				.send(body({ context: 'x'.repeat(10_001) }))
				.expect(400);
			expect(await testPrisma.session.count()).toBe(before);
		});

		it('GET /models lists the default model first; creating with an unlisted model is a 400', async () => {
			const models = await ctx.as('maya').get('/models').expect(200);
			expect(models.body[0]).toEqual({
				provider: 'groq',
				modelId: 'openai/gpt-oss-120b',
				label: 'groq · openai/gpt-oss-120b',
				isDefault: true,
			});
			await ctx
				.as('maya')
				.post('/sessions')
				.send(body({ modelProvider: 'openai', modelId: 'gpt-9' }))
				.expect(400);
			await ctx
				.as('maya')
				.post('/sessions')
				.send(body({ modelProvider: 'groq', modelId: 'openai/gpt-oss-120b' }))
				.expect(201);
			await ctx.http.get('/models').expect(401);
		});
	});
});
