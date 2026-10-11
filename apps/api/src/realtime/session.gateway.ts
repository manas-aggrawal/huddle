import {
	ClientToServerEvents,
	EventType,
	MAX_REPLAY_EVENTS,
	PresenceUpdateRequest,
	ServerToClientEvents,
	SessionJoinAck,
	SessionLeaveAck,
	SessionRole,
	SocketError,
	SocketEvent,
	sessionRoom,
} from '@huddle/shared';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
	ConnectedSocket,
	MessageBody,
	OnGatewayDisconnect,
	OnGatewayInit,
	SubscribeMessage,
	WebSocketGateway,
	WebSocketServer,
} from '@nestjs/websockets';
import { TimelineEvent } from '@prisma/client';
import {
	UserFromJwt,
	UserPayload,
} from '@src/auth/interfaces/token.interfaces';
import {
	ALLOWED_ORIGINS,
	JWT_ACCESS_TOKEN_SECRET,
} from '@src/configs/env-vars';
import { PrismaService } from '@src/prisma/prisma.service';
import {
	TimelineService,
	toTimelineEventDto,
} from '@src/timeline/timeline.service';
import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { PresenceService } from './presence.service';

interface SocketData {
	user: UserFromJwt;
	/** Sessions this socket has joined, so disconnect can clean up presence. */
	sessions: Set<string>;
}

type HuddleServer = Server<
	ClientToServerEvents,
	ServerToClientEvents,
	object,
	SocketData
>;
type HuddleSocket = Socket<
	ClientToServerEvents,
	ServerToClientEvents,
	object,
	SocketData
>;

const JoinSchema = z.object({
	sessionId: z.string().uuid(),
	sinceSeq: z.number().int().min(0).optional(),
});
const LeaveSchema = z.object({ sessionId: z.string().uuid() });
const PresenceUpdateSchema = z.object({
	sessionId: z.string().uuid(),
	viewing: z.string().max(200).nullable().optional(),
	typing: z.boolean().optional(),
});

const error = (status: number, message: string): SocketError => ({
	ok: false,
	error: { status, message },
});

/**
 * The live side of a session. A browser opens one socket (logged in during the
 * handshake), joins the rooms of the sessions it shows, and from then on gets
 * every committed timeline event plus who's online. Reconnecting is just
 * joining again with the last seq seen.
 */
@WebSocketGateway({
	// The document server (/collab) shares this HTTP server; leave its upgrades alone.
	destroyUpgrade: false,
	cors: {
		origin: ALLOWED_ORIGINS
			? ALLOWED_ORIGINS.split(',').map((o) => o.trim())
			: false,
		credentials: true,
	},
})
export class SessionGateway
	implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy
{
	@WebSocketServer() server!: HuddleServer;
	private readonly logger = new Logger(SessionGateway.name);
	private unsubscribe?: () => void;

	constructor(
		private readonly jwt: JwtService,
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly presence: PresenceService,
	) {}

	afterInit(server: HuddleServer) {
		// Log in during the handshake: no valid access token, no connection.
		server.use(async (socket, next) => {
			const token = socket.handshake.auth?.token;
			if (typeof token !== 'string' || token.length === 0) {
				return next(new Error('Unauthorized: missing access token'));
			}
			try {
				const payload = await this.jwt.verifyAsync<UserPayload>(token, {
					secret: JWT_ACCESS_TOKEN_SECRET,
				});
				socket.data.user = {
					id: payload.id,
					email: payload.email,
					username: payload.username,
					role: payload.role,
				};
				socket.data.sessions = new Set();
				next();
			} catch {
				next(new Error('Unauthorized: invalid or expired access token'));
			}
		});

		this.unsubscribe = this.timeline.onCommitted((event) =>
			this.onTimelineEvent(event),
		);
	}

	onModuleDestroy() {
		this.unsubscribe?.();
	}

	@SubscribeMessage(SocketEvent.SESSION_JOIN)
	async join(
		@ConnectedSocket() socket: HuddleSocket,
		@MessageBody() body: unknown,
	): Promise<SessionJoinAck> {
		const parsed = JoinSchema.safeParse(body);
		if (!parsed.success) return error(400, 'Expected { sessionId, sinceSeq? }');
		const { sessionId, sinceSeq = 0 } = parsed.data;
		const user = socket.data.user;

		const membership = await this.prisma.sessionMember.findUnique({
			where: { sessionId_userId: { sessionId, userId: user.id } },
			include: { user: { select: { firstname: true, lastname: true } } },
		});
		// Same answer as the REST API for "doesn't exist" and "not yours".
		if (!membership) return error(404, 'Session not found');

		// Join the room before reading the backlog, so nothing committed in
		// between is missed. The client dedupes the overlap by seq.
		const room = sessionRoom(sessionId);
		await socket.join(room);
		socket.data.sessions.add(sessionId);
		const cameOnline = this.presence.join(sessionId, socket.id, {
			userId: user.id,
			name: `${membership.user.firstname} ${membership.user.lastname}`.trim(),
			role: membership.role as SessionRole,
		});
		if (cameOnline) this.broadcastPresence(sessionId);

		const rows = await this.timeline.listSince(
			sessionId,
			sinceSeq,
			MAX_REPLAY_EVENTS + 1,
		);
		return {
			ok: true,
			sessionId,
			events: rows.slice(0, MAX_REPLAY_EVENTS).map(toTimelineEventDto),
			hasMore: rows.length > MAX_REPLAY_EVENTS,
			presence: this.presence.list(sessionId),
		};
	}

	@SubscribeMessage(SocketEvent.SESSION_LEAVE)
	async leave(
		@ConnectedSocket() socket: HuddleSocket,
		@MessageBody() body: unknown,
	): Promise<SessionLeaveAck> {
		const parsed = LeaveSchema.safeParse(body);
		if (!parsed.success) return error(400, 'Expected { sessionId }');
		await this.leaveRoom(socket, parsed.data.sessionId);
		return { ok: true };
	}

	@SubscribeMessage(SocketEvent.PRESENCE_UPDATE)
	presenceUpdate(
		@ConnectedSocket() socket: HuddleSocket,
		@MessageBody() body: PresenceUpdateRequest,
	): void {
		// Checked first, so a flood costs nothing beyond this line.
		if (!this.presence.allowUpdate(socket.id)) return;
		const parsed = PresenceUpdateSchema.safeParse(body);
		if (!parsed.success) return;
		const { sessionId, ...change } = parsed.data;
		if (!socket.data.sessions.has(sessionId)) return;

		const member = this.presence.update(sessionId, socket.data.user.id, change);
		if (!member) return;
		// Everyone else in the room; the sender already knows.
		socket.to(sessionRoom(sessionId)).emit(SocketEvent.PRESENCE_CHANGED, {
			sessionId,
			member,
		});
	}

	handleDisconnect(socket: HuddleSocket) {
		this.presence.forgetSocket(socket.id);
		// Rooms are already gone at this point; socket.data remembers what it joined.
		for (const sessionId of socket.data.sessions ?? []) {
			if (this.presence.leave(sessionId, socket.id, socket.data.user.id)) {
				this.broadcastPresence(sessionId);
			}
		}
	}

	private async leaveRoom(socket: HuddleSocket, sessionId: string) {
		if (!socket.data.sessions.delete(sessionId)) return;
		await socket.leave(sessionRoom(sessionId));
		if (this.presence.leave(sessionId, socket.id, socket.data.user.id)) {
			this.broadcastPresence(sessionId);
		}
	}

	private broadcastPresence(sessionId: string) {
		this.server.to(sessionRoom(sessionId)).emit(SocketEvent.PRESENCE_STATE, {
			sessionId,
			members: this.presence.list(sessionId),
		});
	}

	/** Runs after each timeline transaction commits. */
	private onTimelineEvent(event: TimelineEvent) {
		const { sessionId } = event;
		this.server
			.to(sessionRoom(sessionId))
			.emit(SocketEvent.TIMELINE_EVENT, toTimelineEventDto(event));

		const payload = event.payload as {
			member?: { id?: string };
			to?: { role?: SessionRole };
		};
		const memberId = payload.member?.id;
		if (!memberId) return;

		if (event.type === EventType.MEMBER_REMOVED) {
			this.kick(sessionId, memberId);
		} else if (event.type === EventType.ROLE_CHANGED && payload.to?.role) {
			if (this.presence.setRole(sessionId, memberId, payload.to.role)) {
				this.broadcastPresence(sessionId);
			}
		}
	}

	/** A removed member stops receiving the session's events at once, in every tab. */
	private kick(sessionId: string, userId: string) {
		const room = sessionRoom(sessionId);
		for (const socketId of this.presence.removeUser(sessionId, userId)) {
			const socket = this.server.sockets.sockets.get(socketId);
			if (!socket) continue;
			socket.data.sessions.delete(sessionId);
			socket.leave(room);
			socket.emit(SocketEvent.SESSION_REMOVED, {
				sessionId,
				reason: 'removed',
			});
		}
		this.logger.log(`Removed user ${userId} from room ${room}`);
		this.broadcastPresence(sessionId);
	}
}
