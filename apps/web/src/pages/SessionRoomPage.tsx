import { type AgentState, can, EventType, SessionStatus } from '@huddle/shared';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
	ApprovalBar,
	ApprovalCard,
	approvalOutcomes,
} from '../components/room/ApprovalBar';
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
import { ApiError } from '../lib/api';
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
					renderExtra={(e) => {
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
