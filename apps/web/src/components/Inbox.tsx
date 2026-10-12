import { SocketEvent } from '@huddle/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { api, unwrap } from '../lib/api';
import { timeAgo } from '../lib/labels';
import { getSocket } from '../lib/socket';
import { BellIcon, cx, Popover } from './ui';

export const inboxKey = ['notifications'] as const;

/** Keeps the inbox and the sessions list fresh when something new arrives for me. */
export function useInboxLive() {
	const queryClient = useQueryClient();
	useEffect(() => {
		const socket = getSocket();
		const onNew = () => {
			void queryClient.invalidateQueries({ queryKey: inboxKey });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		};
		socket.on(SocketEvent.NOTIFICATION_NEW, onNew);
		return () => {
			socket.off(SocketEvent.NOTIFICATION_NEW, onNew);
		};
	}, [queryClient]);
}

/** The bell in the app header: unread notifications, newest first. */
export function Inbox() {
	useInboxLive();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const inbox = useQuery({
		queryKey: inboxKey,
		queryFn: () =>
			unwrap(
				api.GET('/notifications', { params: { query: { unread: 'true' } } }),
			),
	});
	const read = useMutation({
		mutationFn: (id: string) =>
			unwrap(
				api.POST('/notifications/{id}/read', { params: { path: { id } } }),
			),
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: inboxKey });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});
	const readAll = useMutation({
		mutationFn: () => unwrap(api.POST('/notifications/read-all')),
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: inboxKey });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});
	const items = inbox.data ?? [];

	return (
		<Popover
			label={`Inbox, ${items.length} unread`}
			trigger={
				<span className="relative inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
					<BellIcon size={17} />
					{items.length > 0 && (
						<span className="absolute top-1 right-1 min-w-4 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white">
							{items.length > 9 ? '9+' : items.length}
						</span>
					)}
				</span>
			}
			className="p-0"
		>
			{(close) => (
				<div className="flex max-h-[min(28rem,70vh)] flex-col">
					<div className="flex items-center justify-between border-b border-line px-3 py-2">
						<span className="text-sm font-semibold">Inbox</span>
						{items.length > 0 && (
							<button
								type="button"
								className="text-xs text-accent hover:underline"
								onClick={() => readAll.mutate()}
							>
								Mark all read
							</button>
						)}
					</div>
					{items.length === 0 ? (
						<p className="px-3 py-6 text-center text-sm text-muted">
							You’re all caught up.
						</p>
					) : (
						<ul className="overflow-y-auto py-1">
							{items.map((n) => (
								<li key={n.id}>
									<button
										type="button"
										onClick={() => {
											read.mutate(n.id);
											close();
											navigate(
												`/s/${n.sessionId}${n.refId ? `?focus=${n.refId}` : ''}`,
											);
										}}
										className={cx(
											'flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-surface-2',
										)}
									>
										<span className="text-sm">{n.title}</span>
										<span className="text-xs text-muted">
											{n.sessionTitle} · {timeAgo(n.createdAt)}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</Popover>
	);
}
