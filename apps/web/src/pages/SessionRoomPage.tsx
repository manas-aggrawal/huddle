import {
	SessionRole as Role,
	type SessionRole,
	type SessionStatus,
} from '@huddle/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Avatar, Badge, Card } from '../components/ui';
import { useSessionSocket } from '../hooks/useSessionSocket';
import { ApiError, api, unwrap } from '../lib/api';
import { ROLE_LABEL, STATUS_LABEL, timeAgo } from '../lib/labels';

const CONNECTION_LABEL = {
	connecting: { label: 'Connecting…', tone: 'neutral' },
	live: { label: 'Live', tone: 'ok' },
	reconnecting: { label: 'Reconnecting…', tone: 'warn' },
	offline: { label: 'Offline', tone: 'danger' },
} as const;

/**
 * The session room. For now: title, who's online and the live timeline, enough
 * to check realtime and reconnects. The full three-pane room replaces this.
 */
export function SessionRoomPage() {
	const { sessionId } = useParams();
	const session = useQuery({
		queryKey: ['session', sessionId],
		queryFn: () =>
			unwrap(
				api.GET('/sessions/{id}', {
					params: { path: { id: sessionId ?? '' } },
				}),
			),
		enabled: Boolean(sessionId),
		retry: (count, err) =>
			!(err instanceof ApiError && err.status < 500) && count < 2,
	});
	const live = useSessionSocket(session.data ? sessionId : undefined);

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
	const status = STATUS_LABEL[s.status as SessionStatus];
	const connection = CONNECTION_LABEL[live.status];
	const names = new Map(
		s.members.map((m) => [m.userId, `${m.firstname} ${m.lastname}`]),
	);

	return (
		<main className="mx-auto max-w-6xl px-4 py-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="text-xl font-semibold">{s.title}</h1>
						<Badge tone={status.tone}>{status.label}</Badge>
						<Badge tone={connection.tone}>{connection.label}</Badge>
					</div>
					<p className="mt-1 text-sm text-muted">{s.goal}</p>
					<p className="mt-1 text-xs text-muted">
						Your role: {ROLE_LABEL[s.myRole as SessionRole]}
					</p>
				</div>
				<div className="flex items-center -space-x-1.5" aria-label="Online now">
					{live.presence.map((p) => (
						<Avatar
							key={p.userId}
							userId={p.userId}
							name={p.name}
							dashed={p.role === Role.VIEWER}
							typing={p.typing}
						/>
					))}
				</div>
			</div>

			<Card className="mt-6 p-4">
				<h2 className="text-sm font-semibold">Timeline</h2>
				{live.error && (
					<p className="mt-2 text-sm text-danger">{live.error.message}</p>
				)}
				<ol className="mt-3 flex flex-col gap-2">
					{live.events.map((e) => {
						const actor =
							(e.payload.actor as { name?: string } | undefined)?.name ??
							(e.actorId ? names.get(e.actorId) : undefined);
						return (
							<li key={e.seq} className="flex items-baseline gap-3 text-sm">
								<span className="w-8 shrink-0 text-right font-mono text-xs text-muted">
									#{e.seq}
								</span>
								<span className="font-medium">
									{actor ?? (e.actorType === 'AGENT' ? 'Agent' : 'System')}
								</span>
								<span className="text-muted">
									{e.type.toLowerCase().replaceAll('_', ' ')}
								</span>
								<span className="ml-auto shrink-0 text-xs text-muted">
									{timeAgo(e.createdAt)}
								</span>
							</li>
						);
					})}
				</ol>
			</Card>
		</main>
	);
}
