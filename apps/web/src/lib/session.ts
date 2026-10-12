import {
	EventType,
	type SessionRole,
	type TimelineEventDto,
} from '@huddle/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { ApiError, api, type Schemas, unwrap } from './api';

export type SessionDetail = Schemas['SessionDetailDto_Output'];
export type Member = SessionDetail['members'][number];
export type PlanStep = SessionDetail['planSteps'][number];

export const sessionKey = (id: string) => ['session', id] as const;

export function useSessionDetail(sessionId: string | undefined) {
	return useQuery({
		queryKey: sessionKey(sessionId ?? ''),
		queryFn: () =>
			unwrap(
				api.GET('/sessions/{id}', {
					params: { path: { id: sessionId ?? '' } },
				}),
			),
		enabled: Boolean(sessionId),
		// A 404/403 won't fix itself; only retry server errors.
		retry: (count, err) =>
			!(err instanceof ApiError && err.status < 500) && count < 2,
	});
}

/** Timeline events that change what the session detail shows (members, plan, status…). */
const REFETCH_ON = new Set<string>([
	EventType.STATUS_CHANGED,
	EventType.MEMBER_JOINED,
	EventType.MEMBER_REMOVED,
	EventType.ROLE_CHANGED,
	EventType.PLAN_UPDATED,
	EventType.STEP_STARTED,
	EventType.STEP_COMPLETED,
	EventType.APPROVAL_REQUESTED,
	EventType.APPROVAL_RESOLVED,
	EventType.HANDOFF,
	EventType.DECISION_PINNED,
	EventType.DECISION_UNPINNED,
	EventType.MODEL_CHANGED,
]);

/** Keeps the session detail fresh: refetches when a relevant event arrives live. */
export function useRefetchOnEvents(
	sessionId: string | undefined,
	events: TimelineEventDto[],
) {
	const queryClient = useQueryClient();
	const seen = useRef(0);
	useEffect(() => {
		if (!sessionId) return;
		const fresh = events.filter((e) => e.seq > seen.current);
		if (events.length) seen.current = events[events.length - 1].seq;
		// The first batch is the replay the detail already reflects.
		if (fresh.length === events.length) return;
		if (fresh.some((e) => REFETCH_ON.has(e.type))) {
			void queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) });
		}
	}, [sessionId, events, queryClient]);
}

export const memberName = (m: { firstname: string; lastname: string }) =>
	`${m.firstname} ${m.lastname}`.trim();

export const asRole = (r: string) => r as SessionRole;
