// The realtime contract between the API's Socket.IO gateway and the web app.
// Connect with the access token in the handshake: io(url, { auth: { token } }).
// Typed clients: io(...) as Socket<ServerToClientEvents, ClientToServerEvents>.

import type { SessionRole } from './roles';
import type { ActorType, EventType } from './values';

export const SocketEvent = {
	/** Client → server, with an ack: join a session's room and catch up. */
	SESSION_JOIN: 'session:join',
	/** Client → server, with an ack: stop receiving a session's events. */
	SESSION_LEAVE: 'session:leave',
	/** Server → client: you were removed from the session; you've left its room. */
	SESSION_REMOVED: 'session:removed',
	/** Server → client: a new timeline event, sent only after it was saved. */
	TIMELINE_EVENT: 'timeline:event',
	/** Client → server: what I'm looking at / whether I'm typing. Rate limited. */
	PRESENCE_UPDATE: 'presence:update',
	/** Server → client: one person's viewing/typing changed (never echoed to the sender). */
	PRESENCE_CHANGED: 'presence:changed',
	/** Server → client: the full list of who's online, after anyone joins or leaves. */
	PRESENCE_STATE: 'presence:state',
} as const;

/** Most events a single join replays. If `hasMore`, join again with the last seq you got. */
export const MAX_REPLAY_EVENTS = 1000;

/** presence:update messages allowed per socket per second; extra ones are dropped. */
export const PRESENCE_RATE_LIMIT_PER_SECOND = 10;

/** A timeline event as it travels over the wire. */
export interface TimelineEventDto {
	id: string;
	sessionId: string;
	/** 1, 2, 3… per session. Dedupe and order by this: replay and live events can overlap. */
	seq: number;
	type: EventType;
	actorType: ActorType;
	actorId: string | null;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface PresenceMember {
	userId: string;
	name: string;
	role: SessionRole;
	/** What the person is looking at, e.g. a doc section id. Free-form, set by the client. */
	viewing: string | null;
	typing: boolean;
}

export interface SessionJoinRequest {
	sessionId: string;
	/** The highest seq you've already seen. 0 (or omitted) replays from the start. */
	sinceSeq?: number;
}

export type SocketError = {
	ok: false;
	error: { status: number; message: string };
};

export type SessionJoinAck =
	| {
			ok: true;
			sessionId: string;
			/** Events with seq > sinceSeq, oldest first, at most MAX_REPLAY_EVENTS. */
			events: TimelineEventDto[];
			hasMore: boolean;
			presence: PresenceMember[];
	  }
	| SocketError;

export type SessionLeaveAck = { ok: true } | SocketError;

export interface PresenceUpdateRequest {
	sessionId: string;
	viewing?: string | null;
	typing?: boolean;
}

export interface PresenceChanged {
	sessionId: string;
	member: PresenceMember;
}

export interface PresenceState {
	sessionId: string;
	members: PresenceMember[];
}

export interface SessionRemoved {
	sessionId: string;
	reason: 'removed';
}

export interface ClientToServerEvents {
	'session:join': (
		req: SessionJoinRequest,
		ack: (res: SessionJoinAck) => void,
	) => void;
	'session:leave': (
		req: { sessionId: string },
		ack: (res: SessionLeaveAck) => void,
	) => void;
	'presence:update': (req: PresenceUpdateRequest) => void;
}

export interface ServerToClientEvents {
	'timeline:event': (event: TimelineEventDto) => void;
	'presence:state': (state: PresenceState) => void;
	'presence:changed': (change: PresenceChanged) => void;
	'session:removed': (msg: SessionRemoved) => void;
}

/** Socket.IO room name for a session. */
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;
