import { type SessionRole, SessionStatus } from '@huddle/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { NewSessionDialog } from '../components/NewSessionDialog';
import { Avatar, Badge, Button, Card } from '../components/ui';
import { api, type Schemas, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL, STATUS_LABEL, timeAgo } from '../lib/labels';

type Item = Schemas['SessionListItemDto_Output'];

/** Mission control: sessions grouped by what they need from you. */
export function HomePage() {
	const { user } = useAuth();
	const [creating, setCreating] = useState(false);
	const sessions = useQuery({
		queryKey: ['sessions'],
		queryFn: () => unwrap(api.GET('/sessions')),
	});

	const all = sessions.data ?? [];
	const waiting = all.filter(
		(s) => s.waitingOnMe && s.status !== SessionStatus.DONE,
	);
	const done = all.filter((s) => s.status === SessionStatus.DONE);
	const active = all.filter((s) => !waiting.includes(s) && !done.includes(s));

	return (
		<main className="mx-auto max-w-6xl px-4 py-8">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold">
						{user ? `Hi, ${user.firstname}` : 'Your sessions'}
					</h1>
					<p className="mt-1 text-sm text-muted">
						{waiting.length > 0
							? `${waiting.length} ${waiting.length === 1 ? 'session needs' : 'sessions need'} you.`
							: 'Nothing is waiting on you.'}
					</p>
				</div>
				<Button onClick={() => setCreating(true)}>New session</Button>
			</div>
			<NewSessionDialog open={creating} onClose={() => setCreating(false)} />

			{sessions.isPending && (
				<p className="mt-6 text-sm text-muted">Loading sessions…</p>
			)}
			{sessions.isError && (
				<p className="mt-6 text-sm text-danger">
					Couldn't load your sessions: {sessions.error.message}
				</p>
			)}
			{sessions.data?.length === 0 && (
				<Card className="mt-6 p-8 text-center">
					<p className="font-medium">No sessions yet</p>
					<p className="mt-1 text-sm text-muted">
						Start one with the agent, or open an invite link from a teammate.
					</p>
				</Card>
			)}
			<Group title="Waiting on you" items={waiting} highlight />
			<Group title="Running" items={active} />
			<Group title="Done" items={done} />
		</main>
	);
}

function Group({
	title,
	items,
	highlight,
}: {
	title: string;
	items: Item[];
	highlight?: boolean;
}) {
	if (items.length === 0) return null;
	return (
		<section className="mt-8" aria-label={title}>
			<h2 className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wide text-muted uppercase">
				{title}
				<span className="rounded-full bg-surface-2 px-2 text-xs font-medium normal-case">
					{items.length}
				</span>
			</h2>
			<ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{items.map((s) => (
					<li key={s.id}>
						<SessionCard s={s} highlight={highlight} />
					</li>
				))}
			</ul>
		</section>
	);
}

function SessionCard({ s, highlight }: { s: Item; highlight?: boolean }) {
	const status = STATUS_LABEL[s.status as SessionStatus];
	return (
		<Link to={`/s/${s.id}`} className="block h-full">
			<Card
				className={
					highlight
						? 'flex h-full flex-col gap-3 border-warn/50 p-4 transition hover:border-warn'
						: 'flex h-full flex-col gap-3 p-4 transition hover:border-accent'
				}
			>
				<div className="flex items-start justify-between gap-2">
					<h3 className="font-medium leading-snug">{s.title}</h3>
					<div className="flex shrink-0 items-center gap-1">
						{s.unreadCount > 0 && (
							<Badge tone="danger">{s.unreadCount} new</Badge>
						)}
						<Badge tone={status.tone}>{status.label}</Badge>
					</div>
				</div>
				<p className="line-clamp-2 text-sm text-muted">{s.goal}</p>
				<div className="mt-auto flex items-center justify-between gap-2">
					<div className="flex -space-x-2">
						{s.memberPreview.map((m) => (
							<Avatar
								key={m.userId}
								userId={m.userId}
								name={m.name}
								size="sm"
							/>
						))}
						{s.memberCount > s.memberPreview.length && (
							<span className="inline-flex size-7 items-center justify-center rounded-full bg-surface-2 text-[11px] text-muted ring-2 ring-surface">
								+{s.memberCount - s.memberPreview.length}
							</span>
						)}
					</div>
					<span className="truncate text-xs text-muted">
						{s.myRole === 'OWNER'
							? 'Yours'
							: `${s.owner?.name.split(' ')[0] ?? 'Someone'}’s · you’re ${ROLE_LABEL[s.myRole as SessionRole].toLowerCase()}`}{' '}
						· {timeAgo(s.updatedAt)}
					</span>
				</div>
			</Card>
		</Link>
	);
}
