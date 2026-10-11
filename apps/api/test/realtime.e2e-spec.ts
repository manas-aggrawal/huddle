import {
	ActorType,
	EventType,
	PresenceChanged,
	PresenceState,
	SessionJoinAck,
	SessionRemoved,
	SocketEvent,
	TimelineEventDto,
} from '@huddle/shared';
import { TimelineService } from '@src/timeline/timeline.service';
import { Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testPrisma } from './utils/db';
import { E2EContext, setupE2E } from './utils/setup';
import { connectSocket, expectNoEvent, waitForEvent } from './utils/socket';

type Name = 'maya' | 'leo' | 'dana' | 'sam';

describe('Realtime gateway', () => {
	let ctx: E2EContext<Name>;
	let open: Socket[] = [];

	beforeAll(async () => {
		ctx = await setupE2E({ users: ['maya', 'leo', 'dana', 'sam'] });
	});
	afterEach(() => {
		for (const s of open) s.close();
		open = [];
	});
	afterAll(async () => {
		await ctx.close();
	});

	async function connect(name: Name) {
		const socket = await connectSocket(ctx.app, ctx.users[name].token);
		open.push(socket);
		return socket;
	}

	function join(socket: Socket, sessionId: string, sinceSeq?: number) {
		return socket.emitWithAck(SocketEvent.SESSION_JOIN, {
			sessionId,
			sinceSeq,
		}) as Promise<SessionJoinAck>;
	}

	async function joined(socket: Socket, sessionId: string, sinceSeq?: number) {
		const ack = await join(socket, sessionId, sinceSeq);
		if (!ack.ok) throw new Error(`join failed: ${JSON.stringify(ack)}`);
		return ack;
	}

	/** Maya (Owner) with Leo and Dana as Editors. Sam is not a member. Events 1–3. */
	async function team() {
		const s = (
			await ctx
				.as('maya')
				.post('/sessions')
				.send({ title: 'Competitive analysis', goal: 'Compare note apps' })
				.expect(201)
		).body.id as string;
		for (const name of ['leo', 'dana'] as const) {
			const invite = await ctx
				.as('maya')
				.post(`/sessions/${s}/invites`)
				.send({ role: 'EDITOR' })
				.expect(201);
			await ctx
				.as(name)
				.post(`/invites/${invite.body.token}/accept`)
				.expect(200);
		}
		return s;
	}

	const setStatus = (s: string, action: 'pause' | 'resume') =>
		ctx.as('maya').patch(`/sessions/${s}/status`).send({ action }).expect(200);

	const statusEvent = (s: string) => (e: TimelineEventDto) =>
		e.sessionId === s && e.type === EventType.STATUS_CHANGED;

	describe('connecting', () => {
		it('refuses a connection with no token', async () => {
			await expect(connectSocket(ctx.app)).rejects.toThrow(
				/missing access token/,
			);
		});

		it('refuses a connection with a bad token', async () => {
			await expect(connectSocket(ctx.app, 'not-a-jwt')).rejects.toThrow(
				/invalid or expired/,
			);
			// A refresh token is signed with a different secret, so it doesn't work either.
			await expect(
				connectSocket(ctx.app, ctx.users.maya.refreshToken),
			).rejects.toThrow(/invalid or expired/);
		});
	});

	describe('joining a session', () => {
		it("a non-member gets 'Session not found' and none of the session's events", async () => {
			const s = await team();
			const sam = await connect('sam');
			const ack = await join(sam, s);
			expect(ack).toEqual({
				ok: false,
				error: { status: 404, message: 'Session not found' },
			});
			await expect(
				join(sam, '00000000-0000-0000-0000-000000000000'),
			).resolves.toMatchObject({ ok: false, error: { status: 404 } });
			await expect(join(sam, 'not-a-uuid' as string)).resolves.toMatchObject({
				ok: false,
				error: { status: 400 },
			});

			const silent = expectNoEvent(sam, SocketEvent.TIMELINE_EVENT);
			await setStatus(s, 'pause');
			await silent;
		});

		it('replays the whole timeline on a first join, in order', async () => {
			const s = await team();
			const ack = await joined(await connect('leo'), s);
			expect(ack.events.map((e) => [e.seq, e.type])).toEqual([
				[1, EventType.SESSION_CREATED],
				[2, EventType.MEMBER_JOINED],
				[3, EventType.MEMBER_JOINED],
			]);
			expect(ack.hasMore).toBe(false);
			expect(ack.events[0]).toMatchObject({
				sessionId: s,
				actorType: ActorType.USER,
				actorId: ctx.users.maya.id,
				payload: { title: 'Competitive analysis' },
			});
		});

		it('joining with "seen up to #3" returns only the events after #3, in order', async () => {
			const s = await team();
			await setStatus(s, 'pause'); // 4
			await setStatus(s, 'resume'); // 5
			const ack = await joined(await connect('leo'), s, 3);
			expect(ack.events.map((e) => e.seq)).toEqual([4, 5]);
			expect(ack.events.map((e) => e.payload.action)).toEqual([
				'pause',
				'resume',
			]);

			const upToDate = await joined(await connect('leo'), s, 5);
			expect(upToDate.events).toEqual([]);
		});
	});

	describe('live events', () => {
		it('Maya and Leo both receive the event from a REST change, with the same number', async () => {
			const s = await team();
			const maya = await connect('maya');
			const leo = await connect('leo');
			await joined(maya, s);
			await joined(leo, s);

			const mayaGets = waitForEvent(
				maya,
				SocketEvent.TIMELINE_EVENT,
				statusEvent(s),
			);
			const leoGets = waitForEvent(
				leo,
				SocketEvent.TIMELINE_EVENT,
				statusEvent(s),
			);
			await setStatus(s, 'pause');

			const [a, b] = (await Promise.all([
				mayaGets,
				leoGets,
			])) as TimelineEventDto[];
			expect(a.seq).toBe(4);
			expect(b).toEqual(a);
			expect(a.payload).toMatchObject({ action: 'pause', to: 'PAUSED' });
		});

		it("doesn't send a session's events to sockets that only joined another session", async () => {
			const s1 = await team();
			const s2 = await team();
			const leo = await connect('leo');
			await joined(leo, s2);
			const silent = expectNoEvent(leo, SocketEvent.TIMELINE_EVENT);
			await setStatus(s1, 'pause');
			await silent;
		});

		it('stops sending events after session:leave', async () => {
			const s = await team();
			const leo = await connect('leo');
			await joined(leo, s);
			await expect(
				leo.emitWithAck(SocketEvent.SESSION_LEAVE, { sessionId: s }),
			).resolves.toEqual({ ok: true });
			const silent = expectNoEvent(leo, SocketEvent.TIMELINE_EVENT);
			await setStatus(s, 'pause');
			await silent;
		});

		it('a change that rolls back announces nothing; one that commits is announced', async () => {
			const s = await team();
			const maya = await connect('maya');
			await joined(maya, s);
			const timeline = ctx.app.get(TimelineService);
			const event = {
				type: EventType.AGENT_MESSAGE,
				actorType: ActorType.AGENT,
				payload: { text: 'draft' },
			};

			const silent = expectNoEvent(maya, SocketEvent.TIMELINE_EVENT);
			await expect(
				timeline.transaction(async (tx) => {
					await timeline.append(tx, s, event);
					throw new Error('the change failed');
				}),
			).rejects.toThrow(/failed/);
			await silent;

			const arrives = waitForEvent<TimelineEventDto>(
				maya,
				SocketEvent.TIMELINE_EVENT,
			);
			await timeline.record(s, event);
			// Same number the rolled-back event would have had: no gap.
			expect((await arrives).seq).toBe(4);
		});

		it('refuses appends outside timeline.transaction(), which would never be announced', async () => {
			const s = await team();
			const timeline = ctx.app.get(TimelineService);
			await expect(
				testPrisma.$transaction((tx) =>
					timeline.append(tx, s, {
						type: EventType.AGENT_MESSAGE,
						actorType: ActorType.AGENT,
						payload: {},
					}),
				),
			).rejects.toThrow(/inside timeline.transaction/);
		});
	});

	describe('presence', () => {
		const names = (state: PresenceState) => state.members.map((m) => m.name);

		it("shows Leo in Maya's online list when he joins, and drops him when he disconnects", async () => {
			const s = await team();
			const maya = await connect('maya');
			const first = await joined(maya, s);
			expect(first.presence.map((m) => m.name)).toEqual(['maya Tester']);

			const leo = await connect('leo');
			const bothOnline = waitForEvent<PresenceState>(
				maya,
				SocketEvent.PRESENCE_STATE,
				(p) => p.members.length === 2,
			);
			const leoAck = await joined(leo, s);
			expect(names(await bothOnline)).toEqual(['leo Tester', 'maya Tester']);
			expect(leoAck.presence).toHaveLength(2);
			expect(
				leoAck.presence.find((m) => m.userId === ctx.users.leo.id),
			).toEqual({
				userId: ctx.users.leo.id,
				name: 'leo Tester',
				role: 'EDITOR',
				viewing: null,
				typing: false,
			});

			const leoGone = waitForEvent<PresenceState>(
				maya,
				SocketEvent.PRESENCE_STATE,
				(p) => p.members.length === 1,
			);
			leo.close();
			expect(names(await leoGone)).toEqual(['maya Tester']);
		});

		it("Maya's typing reaches Leo but isn't sent back to Maya", async () => {
			const s = await team();
			const maya = await connect('maya');
			const leo = await connect('leo');
			await joined(maya, s);
			await joined(leo, s);

			const leoSees = waitForEvent<PresenceChanged>(
				leo,
				SocketEvent.PRESENCE_CHANGED,
			);
			const mayaHearsNothing = expectNoEvent(
				maya,
				SocketEvent.PRESENCE_CHANGED,
			);
			maya.emit(SocketEvent.PRESENCE_UPDATE, {
				sessionId: s,
				typing: true,
				viewing: 'section-2',
			});

			expect(await leoSees).toEqual({
				sessionId: s,
				member: expect.objectContaining({
					userId: ctx.users.maya.id,
					typing: true,
					viewing: 'section-2',
				}),
			});
			await mayaHearsNothing;

			// The change sticks, so someone joining later sees it.
			const dana = await joined(await connect('dana'), s);
			expect(
				dana.presence.find((m) => m.userId === ctx.users.maya.id),
			).toMatchObject({
				typing: true,
				viewing: 'section-2',
			});
		});

		it('ignores presence updates for a session the socket has not joined', async () => {
			const s = await team();
			const leo = await connect('leo');
			await joined(leo, s);
			const sam = await connect('sam');
			const silent = expectNoEvent(leo, SocketEvent.PRESENCE_CHANGED);
			sam.emit(SocketEvent.PRESENCE_UPDATE, { sessionId: s, typing: true });
			await silent;
		});

		it('lets only 10 presence updates per second through from one socket', async () => {
			const s = await team();
			const maya = await connect('maya');
			const leo = await connect('leo');
			await joined(maya, s);
			await joined(leo, s);

			let received = 0;
			leo.on(SocketEvent.PRESENCE_CHANGED, () => {
				received++;
			});
			for (let i = 0; i < 30; i++) {
				maya.emit(SocketEvent.PRESENCE_UPDATE, {
					sessionId: s,
					typing: i % 2 === 0,
				});
			}
			await new Promise((r) => setTimeout(r, 400));
			expect(received).toBe(10);

			// The window slides: a second later, updates go through again.
			await new Promise((r) => setTimeout(r, 700));
			const again = waitForEvent(leo, SocketEvent.PRESENCE_CHANGED);
			maya.emit(SocketEvent.PRESENCE_UPDATE, { sessionId: s, typing: false });
			await again;
		});

		it('two tabs for Leo show as one person, who goes offline only when both close', async () => {
			const s = await team();
			const maya = await connect('maya');
			await joined(maya, s);
			const tab1 = await connect('leo');
			const tab2 = await connect('leo');
			await joined(tab1, s);
			const ack = await joined(tab2, s);
			expect(ack.presence.map((m) => m.name)).toEqual([
				'leo Tester',
				'maya Tester',
			]);

			const noChange = expectNoEvent(maya, SocketEvent.PRESENCE_STATE);
			tab1.close();
			await noChange;

			const leoGone = waitForEvent<PresenceState>(
				maya,
				SocketEvent.PRESENCE_STATE,
				(p) => p.members.length === 1,
			);
			tab2.close();
			expect(names(await leoGone)).toEqual(['maya Tester']);
		});

		it('updates the online list when the Owner changes a role', async () => {
			const s = await team();
			const maya = await connect('maya');
			await joined(maya, s);
			await joined(await connect('leo'), s);

			const updated = waitForEvent<PresenceState>(
				maya,
				SocketEvent.PRESENCE_STATE,
				(p) =>
					p.members.some(
						(m) => m.userId === ctx.users.leo.id && m.role === 'VIEWER',
					),
			);
			await ctx
				.as('maya')
				.patch(`/sessions/${s}/members/${ctx.users.leo.id}`)
				.send({ role: 'VIEWER' })
				.expect(200);
			await updated;
		});
	});

	describe('removed members', () => {
		it('once the Owner removes Dana, every tab of hers is told and stops getting events', async () => {
			const s = await team();
			const maya = await connect('maya');
			const dana1 = await connect('dana');
			const dana2 = await connect('dana');
			await joined(maya, s);
			await joined(dana1, s);
			await joined(dana2, s);

			const told = [dana1, dana2].map((d) =>
				waitForEvent<SessionRemoved>(d, SocketEvent.SESSION_REMOVED),
			);
			const danaOffline = waitForEvent<PresenceState>(
				maya,
				SocketEvent.PRESENCE_STATE,
				(p) => !p.members.some((m) => m.userId === ctx.users.dana.id),
			);
			await ctx
				.as('maya')
				.delete(`/sessions/${s}/members/${ctx.users.dana.id}`)
				.expect(204);
			for (const t of told) {
				expect(await t).toEqual({ sessionId: s, reason: 'removed' });
			}
			await danaOffline;

			const silent = Promise.all(
				[dana1, dana2].map((d) => expectNoEvent(d, SocketEvent.TIMELINE_EVENT)),
			);
			const mayaGets = waitForEvent(
				maya,
				SocketEvent.TIMELINE_EVENT,
				statusEvent(s),
			);
			await setStatus(s, 'pause');
			await mayaGets;
			await silent;

			// And she can't simply join again.
			await expect(join(dana1, s)).resolves.toMatchObject({
				ok: false,
				error: { status: 404 },
			});
		});
	});
});
