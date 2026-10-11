import {
	type PresenceMember,
	type PresenceUpdateRequest,
	type SessionJoinAck,
	SocketEvent,
	type TimelineEventDto,
} from '@huddle/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSocket } from '../lib/socket';

export type ConnectionStatus =
	| 'connecting'
	| 'live'
	| 'reconnecting'
	| 'offline';

export interface SessionSocketState {
	status: ConnectionStatus;
	/** Every timeline event so far, oldest first, without gaps or duplicates. */
	events: TimelineEventDto[];
	presence: PresenceMember[];
	/** Set when the server refused the join (e.g. 404 for a non-member). */
	error: { status: number; message: string } | null;
	/** The Owner removed you from the session. */
	removed: boolean;
	/** Send what you're looking at / whether you're typing (rate limited server-side). */
	updatePresence: (change: Omit<PresenceUpdateRequest, 'sessionId'>) => void;
}

/** Adds events to the list, ordered by seq, dropping ones we already have (replay and live overlap). */
function merge(
	list: TimelineEventDto[],
	incoming: TimelineEventDto[],
): TimelineEventDto[] {
	const lastSeq = list.at(-1)?.seq ?? 0;
	const fresh = incoming.filter((e) => e.seq > lastSeq);
	if (fresh.length === 0) return list;
	if (fresh.every((e, i) => i === 0 || e.seq > fresh[i - 1].seq))
		return [...list, ...fresh];
	const bySeq = new Map(list.map((e) => [e.seq, e]));
	for (const e of fresh) bySeq.set(e.seq, e);
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Joins a session's live room. On every (re)connect it rejoins with the last
 * seq it has, so it only gets what it missed.
 */
export function useSessionSocket(
	sessionId: string | undefined,
): SessionSocketState {
	const [status, setStatus] = useState<ConnectionStatus>('connecting');
	const [events, setEvents] = useState<TimelineEventDto[]>([]);
	const [presence, setPresence] = useState<PresenceMember[]>([]);
	const [error, setError] = useState<SessionSocketState['error']>(null);
	const [removed, setRemoved] = useState(false);
	const lastSeq = useRef(0);

	useEffect(() => {
		if (!sessionId) return;
		const socket = getSocket();
		let cancelled = false;
		lastSeq.current = 0;
		setEvents([]);
		setPresence([]);
		setError(null);
		setRemoved(false);
		setStatus(socket.connected ? 'live' : 'connecting');

		const apply = (incoming: TimelineEventDto[]) => {
			if (incoming.length === 0) return;
			setEvents((list) => {
				const next = merge(list, incoming);
				lastSeq.current = next.at(-1)?.seq ?? 0;
				return next;
			});
		};

		const join = async () => {
			// Keep asking until we've caught up (the server sends at most 1000 per join).
			for (;;) {
				const ack: SessionJoinAck = await socket.emitWithAck(
					SocketEvent.SESSION_JOIN,
					{
						sessionId,
						sinceSeq: lastSeq.current,
					},
				);
				if (cancelled) return;
				if (!ack.ok) {
					setError(ack.error);
					return;
				}
				setError(null);
				setPresence(ack.presence);
				apply(ack.events);
				const last = ack.events.at(-1)?.seq;
				if (last !== undefined)
					lastSeq.current = Math.max(lastSeq.current, last);
				if (!ack.hasMore) break;
			}
			setStatus('live');
		};

		const onConnect = () => {
			void join();
		};
		const onDisconnect = () => setStatus('reconnecting');
		const onConnectError = () =>
			setStatus(socket.active ? 'reconnecting' : 'offline');
		const onEvent = (e: TimelineEventDto) => {
			if (e.sessionId === sessionId) apply([e]);
		};
		const onPresenceState = (p: {
			sessionId: string;
			members: PresenceMember[];
		}) => {
			if (p.sessionId === sessionId) setPresence(p.members);
		};
		const onPresenceChanged = (p: {
			sessionId: string;
			member: PresenceMember;
		}) => {
			if (p.sessionId !== sessionId) return;
			setPresence((list) =>
				list.map((m) => (m.userId === p.member.userId ? p.member : m)),
			);
		};
		const onRemoved = (p: { sessionId: string }) => {
			if (p.sessionId !== sessionId) return;
			setRemoved(true);
			setPresence([]);
		};

		socket.on('connect', onConnect);
		socket.on('disconnect', onDisconnect);
		socket.on('connect_error', onConnectError);
		socket.on(SocketEvent.TIMELINE_EVENT, onEvent);
		socket.on(SocketEvent.PRESENCE_STATE, onPresenceState);
		socket.on(SocketEvent.PRESENCE_CHANGED, onPresenceChanged);
		socket.on(SocketEvent.SESSION_REMOVED, onRemoved);
		if (socket.connected) void join();

		return () => {
			cancelled = true;
			socket.off('connect', onConnect);
			socket.off('disconnect', onDisconnect);
			socket.off('connect_error', onConnectError);
			socket.off(SocketEvent.TIMELINE_EVENT, onEvent);
			socket.off(SocketEvent.PRESENCE_STATE, onPresenceState);
			socket.off(SocketEvent.PRESENCE_CHANGED, onPresenceChanged);
			socket.off(SocketEvent.SESSION_REMOVED, onRemoved);
			if (socket.connected)
				socket.emit(SocketEvent.SESSION_LEAVE, { sessionId }, () => undefined);
		};
	}, [sessionId]);

	const updatePresence = useCallback(
		(change: Omit<PresenceUpdateRequest, 'sessionId'>) => {
			if (sessionId)
				getSocket().emit(SocketEvent.PRESENCE_UPDATE, { sessionId, ...change });
		},
		[sessionId],
	);

	return { status, events, presence, error, removed, updatePresence };
}
