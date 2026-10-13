import { type AgentState, can, EventType, SessionStatus } from '@huddle/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
	ApprovalBar,
	ApprovalCard,
	approvalOutcomes,
} from '../components/room/ApprovalBar';
import { BriefingCard } from '../components/room/BriefingCard';
import { CatchUpCard } from '../components/room/CatchUpCard';
import { Composer } from '../components/room/Composer';
import {
	ConflictCard,
	conflictResolutions,
} from '../components/room/ConflictCard';
import { commentsKey } from '../components/room/DocComments';
import { DocPane } from '../components/room/DocPane';
import { PinnedDecisions } from '../components/room/PinnedDecisions';
import { PlanPane } from '../components/room/PlanPane';
import { Replay } from '../components/room/Replay';
import { RoomHeader } from '../components/room/RoomHeader';
import { TimelinePane } from '../components/room/TimelinePane';
import { ToolCallLinks } from '../components/room/ToolCallLinks';
import { useSessionSocket } from '../hooks/useSessionSocket';
import { ApiError, api, unwrap } from '../lib/api';
import { fullName, useAuth } from '../lib/auth';
import {
	asRole,
	memberName,
	useRefetchOnEvents,
	useSessionDetail,
} from '../lib/session';

/**
 * The session room: header, then plan | document | timeline. On narrow
 * screens the panes stack (plan, document, timeline).
 */
export function SessionRoomPage() {
	const { sessionId } = useParams();
	const { user } = useAuth();
	const session = useSessionDetail(sessionId);
	// Join the live room only once we know we're a member.
	const live = useSessionSocket(session.data ? sessionId : undefined);
	useRefetchOnEvents(sessionId, live.events, session.data?.lastEventSeq);
	const names = useMemo(
		() =>
			new Map(
				(session.data?.members ?? []).map((m) => [m.userId, memberName(m)]),
			),
		[session.data?.members],
	);
	const outcomes = useMemo(() => approvalOutcomes(live.events), [live.events]);
	const resolutions = useMemo(
		() => conflictResolutions(live.events),
		[live.events],
	);
	const [draft, setDraft] = useState<{ text: string; n: number } | null>(null);
	const [jumpTo, setJumpTo] = useState<{ seq: number; n: number } | null>(null);
	const showEvent = useCallback(
		(seq: number) => setJumpTo((j) => ({ seq, n: (j?.n ?? 0) + 1 })),
		[],
	);
	// Read once per visit, before this visit marks anything as seen.
	const catchUp = useQuery({
		queryKey: ['catch-up', sessionId],
		queryFn: () =>
			unwrap(
				api.GET('/sessions/{id}/catch-up', {
					params: { path: { id: sessionId ?? '' } },
				}),
			),
		enabled: Boolean(session.data),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 0,
		retry: false,
	});
	useMarkSeen(sessionId, live.events.at(-1)?.seq, !catchUp.isPending);
	useRefreshComments(sessionId, live.events);
	// Opened from the inbox: jump to the event the notification is about.
	const [params, setParams] = useSearchParams();
	const focus = params.get('focus');
	useEffect(() => {
		if (!focus) return;
		const ids = ['approvalId', 'messageId', 'conflictId', 'handoffId'];
		const hit = live.events.find((e) =>
			ids.some((k) => (e.payload as Record<string, unknown>)[k] === focus),
		);
		if (!hit) return;
		setJumpTo((j) => ({ seq: hit.seq, n: (j?.n ?? 0) + 1 }));
		setParams({}, { replace: true });
	}, [focus, live.events, setParams]);

	if (session.isPending) {
		return (
			<p className="mx-auto max-w-6xl px-4 py-8 text-sm text-muted">
				Loading session…
			</p>
		);
	}
	if (session.isError || live.removed) {
		const notFound =
			session.error instanceof ApiError && session.error.status === 404;
		return (
			<main className="mx-auto max-w-xl px-4 py-16 text-center">
				<h1 className="text-xl font-semibold">
					{live.removed === 'deleted'
						? 'This session was deleted'
						: live.removed
							? "You're no longer in this session"
							: notFound
								? 'Session not found'
								: "Couldn't load this session"}
				</h1>
				<p className="mt-2 text-sm text-muted">
					{live.removed === 'deleted'
						? 'The Owner deleted it, along with its document and history.'
						: live.removed
							? 'The Owner removed you. Ask them for a new invite if this was a mistake.'
							: notFound
								? "It doesn't exist, or you're not a member. Ask the Owner for an invite link."
								: session.error?.message}
				</p>
				<Link
					to="/"
					className="mt-6 inline-block text-sm font-medium text-accent hover:underline"
				>
					Back to your sessions
				</Link>
			</main>
		);
	}

	const s = session.data;
	const me = { role: asRole(s.myRole), canApprove: s.myCanApprove };

	return (
		// Fills the screen under the app header on wide screens; scrolls as one page when stacked.
		<main className="flex flex-col lg:h-[calc(100dvh-3.5rem)]">
			<RoomHeader
				session={s}
				presence={live.presence}
				connection={live.status}
				agentState={live.agent?.state ?? (s.agentState as AgentState)}
				usage={live.usage}
			/>
			<ApprovalBar session={s} me={me} />
			{s.status === SessionStatus.DONE && (
				<DoneBanner session={s} events={live.events} />
			)}
			<div className="grid min-h-0 flex-1 gap-px bg-line lg:grid-cols-[17rem_minmax(0,1fr)_21rem]">
				<PlanPane
					sessionId={s.id}
					canEdit={can(me, 'editPlan') && s.status !== SessionStatus.DONE}
					steps={s.planSteps}
					footer={
						<PinnedDecisions
							sessionId={s.id}
							decisions={s.decisions}
							canPin={can(me, 'pinDecision') && s.status !== SessionStatus.DONE}
						/>
					}
					gatedStepIds={
						new Set(
							s.pendingApprovals
								.map((a) => a.planStepId)
								.filter((x): x is string => Boolean(x)),
						)
					}
					planning={
						s.status === SessionStatus.PLANNING &&
						s.pendingApprovals.length === 0
					}
					className="max-h-80 lg:max-h-none"
				/>
				{user && (
					<DocPane
						sessionId={s.id}
						names={names}
						me={{ userId: user.id, name: fullName(user) }}
						canEdit={can(me, 'editDoc')}
						onViewing={(viewing) => live.updatePresence({ viewing })}
						className="min-h-[24rem]"
					/>
				)}
				<TimelinePane
					events={live.events}
					names={names}
					jumpTo={jumpTo}
					header={
						<>
							{s.lastHandoff && s.lastHandoff.to.id === user?.id && (
								<BriefingCard handoff={s.lastHandoff} />
							)}
							{s.status === SessionStatus.DONE && (
								<Replay events={live.events} onShow={showEvent} />
							)}
							{catchUp.data && s.status !== SessionStatus.DONE && (
								<CatchUpCard
									sessionId={s.id}
									catchUp={catchUp.data}
									stillOpen={
										new Set([
											...s.pendingApprovals.map((a) => a.id),
											...s.openConflicts.map((c) => c.id),
										])
									}
									onJump={(seq) =>
										setJumpTo((j) => ({ seq, n: (j?.n ?? 0) + 1 }))
									}
								/>
							)}
						</>
					}
					renderExtra={(e) => {
						if (e.type === EventType.HANDOFF) {
							const h = e.payload as { briefing?: string };
							return h.briefing ? (
								<details className="mt-1 text-sm">
									<summary className="cursor-pointer text-xs text-accent">
										Read the briefing
									</summary>
									<p className="mt-1 whitespace-pre-line rounded-lg bg-surface-2 p-2">
										{h.briefing}
									</p>
								</details>
							) : null;
						}
						if (e.type === EventType.TOOL_CALL) {
							return <ToolCallLinks payload={e.payload} />;
						}
						if (e.type === EventType.CONFLICT_RAISED) {
							const c = e.payload as {
								conflictId: string;
								stepTitle: string | null;
								sides: {
									messageId: string;
									content: string;
									author: { id: string; name: string };
								}[];
							};
							return (
								<ConflictCard
									sessionId={s.id}
									conflictId={c.conflictId}
									sides={c.sides ?? []}
									stepTitle={c.stepTitle}
									open={s.openConflicts.some((o) => o.id === c.conflictId)}
									resolved={resolutions.get(c.conflictId)}
									canResolve={can(me, 'resolveConflict')}
								/>
							);
						}
						if (e.type !== EventType.APPROVAL_REQUESTED) return null;
						const p = e.payload as {
							approvalId: string;
							kind: string;
							title: string;
							details?: unknown;
						};
						return (
							<ApprovalCard
								sessionId={s.id}
								approvalId={p.approvalId}
								kind={p.kind}
								details={p.details}
								pending={s.pendingApprovals.some((a) => a.id === p.approvalId)}
								outcome={outcomes.get(p.approvalId)}
								canApprove={can(me, 'approve')}
								onDiscuss={() =>
									setDraft((d) => ({
										text: `About “${p.title}”: `,
										n: (d?.n ?? 0) + 1,
									}))
								}
							/>
						);
					}}
					className="h-[32rem] lg:h-auto"
					footer={
						user && (
							<Composer
								sessionId={s.id}
								me={me}
								myUserId={user.id}
								members={s.members}
								presence={live.presence}
								askOnly={s.status === SessionStatus.DONE}
								onTyping={(typing) => live.updatePresence({ typing })}
								draft={draft}
							/>
						)
					}
				/>
			</div>
		</main>
	);
}

/**
 * Viewing the room counts as seeing the timeline: the newest seq is saved a
 * couple of seconds after it arrives, while the tab is visible.
 */
function useMarkSeen(
	sessionId: string | undefined,
	lastSeq: number | undefined,
	enabled: boolean,
) {
	useEffect(() => {
		if (!sessionId || !lastSeq || !enabled) return;
		const t = setTimeout(() => {
			if (document.visibilityState !== 'visible') return;
			void api.POST('/sessions/{id}/seen', {
				params: { path: { id: sessionId } },
				body: { seq: lastSeq },
			});
		}, 2000);
		return () => clearTimeout(t);
	}, [sessionId, lastSeq, enabled]);
}

/** New comments, and the agent's replies to them, refresh the doc's comment threads. */
function useRefreshComments(
	sessionId: string | undefined,
	events: { seq: number; type: string; payload: Record<string, unknown> }[],
) {
	const queryClient = useQueryClient();
	const last = events.at(-1);
	useEffect(() => {
		if (!sessionId || !last) return;
		const isComment =
			(last.type === EventType.HUMAN_MESSAGE ||
				last.type === EventType.AGENT_ACK) &&
			last.payload.mode === 'COMMENT';
		if (isComment)
			void queryClient.invalidateQueries({ queryKey: commentsKey(sessionId) });
	}, [sessionId, last, queryClient]);
}

/** Who finished it and when; the doc is read-only from here on. */
function DoneBanner({
	session,
	events,
}: {
	session: { completedAt: string | null };
	events: { type: string; payload: Record<string, unknown> }[];
}) {
	const ended = [...events]
		.reverse()
		.find(
			(e) =>
				(e.type === EventType.APPROVAL_RESOLVED &&
					e.payload.kind === 'MARK_FINAL') ||
				(e.type === EventType.STATUS_CHANGED && e.payload.to === 'DONE'),
		);
	const by = (ended?.payload.actor as { name?: string } | undefined)?.name;
	const when = session.completedAt
		? new Date(session.completedAt).toLocaleString()
		: null;
	return (
		<div
			className="border-b border-line bg-ok-soft/60 px-4 py-2.5 text-sm"
			role="status"
		>
			<span className="font-medium text-ok">Done.</span>{' '}
			{ended?.type === EventType.APPROVAL_RESOLVED ? 'Marked final' : 'Ended'}
			{by && ` by ${by}`}
			{when && ` on ${when}`}. The document is read-only; you can still ask the
			agent questions, and replay how it was made.
		</div>
	);
}
