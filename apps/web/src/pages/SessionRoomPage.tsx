import { type AgentState, can, EventType, SessionStatus } from '@huddle/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
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
import { DocPane } from '../components/room/DocPane';
import { PinnedDecisions } from '../components/room/PinnedDecisions';
import { PlanPane } from '../components/room/PlanPane';
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
	useRefetchOnEvents(sessionId, live.events);
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
					{live.removed
						? "You're no longer in this session"
						: notFound
							? 'Session not found'
							: "Couldn't load this session"}
				</h1>
				<p className="mt-2 text-sm text-muted">
					{live.removed
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
			<div className="grid min-h-0 flex-1 gap-px bg-line lg:grid-cols-[17rem_minmax(0,1fr)_21rem]">
				<PlanPane
					sessionId={s.id}
					canEdit={can(me, 'editPlan') && s.status !== SessionStatus.DONE}
					steps={s.planSteps}
					footer={
						<PinnedDecisions
							sessionId={s.id}
							decisions={s.decisions}
							canPin={can(me, 'pinDecision')}
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
							{catchUp.data && (
								<CatchUpCard
									sessionId={s.id}
									catchUp={catchUp.data}
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
