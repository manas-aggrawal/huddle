import type { SessionRole, SessionStatus } from '@huddle/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Badge, Card } from '../components/ui';
import { api, unwrap } from '../lib/api';
import { fullName, useAuth } from '../lib/auth';
import { ROLE_LABEL, STATUS_LABEL, timeAgo } from '../lib/labels';

export function HomePage() {
	const { user } = useAuth();
	const sessions = useQuery({
		queryKey: ['sessions'],
		queryFn: () => unwrap(api.GET('/sessions')),
	});

	return (
		<main className="mx-auto max-w-6xl px-4 py-8">
			<h1 className="text-2xl font-semibold">
				{user ? `Hi, ${user.firstname}` : 'Your sessions'}
			</h1>
			<p className="mt-1 text-sm text-muted">
				Sessions you're part of, most recently active first.
			</p>

			<section className="mt-6">
				{sessions.isPending && (
					<p className="text-sm text-muted">Loading sessions…</p>
				)}
				{sessions.isError && (
					<p className="text-sm text-danger">
						Couldn't load your sessions: {sessions.error.message}
					</p>
				)}
				{sessions.data?.length === 0 && (
					<Card className="p-8 text-center">
						<p className="font-medium">No sessions yet</p>
						<p className="mt-1 text-sm text-muted">
							When someone invites you, the session shows up here.
						</p>
					</Card>
				)}
				{sessions.data && sessions.data.length > 0 && (
					<ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{sessions.data.map((s) => {
							const status = STATUS_LABEL[s.status as SessionStatus];
							return (
								<li key={s.id}>
									<Link to={`/s/${s.id}`} className="block h-full">
										<Card className="flex h-full flex-col gap-3 p-4 transition hover:border-accent">
											<div className="flex items-start justify-between gap-2">
												<h2 className="font-medium leading-snug">{s.title}</h2>
												<Badge tone={status.tone}>{status.label}</Badge>
											</div>
											<p className="line-clamp-2 text-sm text-muted">
												{s.goal}
											</p>
											<div className="mt-auto flex items-center gap-2 text-xs text-muted">
												<span>{ROLE_LABEL[s.myRole as SessionRole]}</span>
												<span aria-hidden>·</span>
												<span>
													{s.memberCount}{' '}
													{s.memberCount === 1 ? 'member' : 'members'}
												</span>
												<span aria-hidden>·</span>
												<span>{timeAgo(s.updatedAt)}</span>
											</div>
										</Card>
									</Link>
								</li>
							);
						})}
					</ul>
				)}
			</section>
			{user && <p className="sr-only">Logged in as {fullName(user)}</p>}
		</main>
	);
}
