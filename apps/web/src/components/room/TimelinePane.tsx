import {
	EventType,
	type MessageStatus,
	type TimelineEventDto,
} from '@huddle/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { timeAgo } from '../../lib/labels';
import {
	MESSAGE_STATUS,
	messageStatuses,
	showMentions,
} from '../../lib/messages';
import { Avatar, Badge, BotIcon, Button, cx } from '../ui';
import { actorName, describeEvent } from './describeEvent';
import { Pane } from './Pane';

/** Live timeline: virtualized, and follows new events while you're at the bottom. */
export function TimelinePane({
	events,
	names,
	footer,
	renderExtra,
	className,
}: {
	events: TimelineEventDto[];
	/** userId → display name, for showing @mentions. */
	names: Map<string, string>;
	/** The composer, pinned under the list. */
	footer?: ReactNode;
	/** Extra content under an event (e.g. an approval card). */
	renderExtra?: (event: TimelineEventDto) => ReactNode;
	className?: string;
}) {
	const statuses = useMemo(() => messageStatuses(events), [events]);
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	const [showJump, setShowJump] = useState(false);
	const [, tick] = useState(0);

	const virtualizer = useVirtualizer({
		count: events.length,
		getScrollElement: () => scroller.current,
		estimateSize: () => 56,
		overscan: 8,
		getItemKey: (i) => events[i].seq,
	});

	// Follow the newest event, but only if the reader hasn't scrolled up.
	useLayoutEffect(() => {
		if (events.length === 0) return;
		if (atBottom.current)
			virtualizer.scrollToIndex(events.length - 1, { align: 'end' });
		else setShowJump(true);
	}, [events.length, virtualizer]);

	// Refresh "5 minutes ago" labels.
	useEffect(() => {
		const t = setInterval(() => tick((n) => n + 1), 30_000);
		return () => clearInterval(t);
	}, []);

	const onScroll = () => {
		const el = scroller.current;
		if (!el) return;
		atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
		if (atBottom.current) setShowJump(false);
	};

	return (
		<Pane title="Timeline" className={className} bodyClassName="flex flex-col">
			<div className="relative min-h-0 flex-1">
				<div
					ref={scroller}
					onScroll={onScroll}
					className="h-full overflow-y-auto"
					aria-live="polite"
				>
					{events.length === 0 ? (
						<p className="p-4 text-sm text-muted">Nothing has happened yet.</p>
					) : (
						<ol
							style={{
								height: virtualizer.getTotalSize(),
								position: 'relative',
							}}
						>
							{virtualizer.getVirtualItems().map((item) => {
								const e = events[item.index];
								const { text, detail } = describeEvent(e);
								const name = actorName(e);
								const p = e.payload as {
									messageId?: string;
									mode?: string;
									kind?: string;
								};
								const status =
									e.type === EventType.HUMAN_MESSAGE && p.messageId
										? MESSAGE_STATUS[statuses.get(p.messageId) as MessageStatus]
										: undefined;
								return (
									<li
										key={item.key}
										data-index={item.index}
										ref={virtualizer.measureElement}
										className="absolute top-0 left-0 w-full px-3 py-2"
										style={{ transform: `translateY(${item.start}px)` }}
									>
										<div className="flex gap-2.5">
											{e.actorType === 'USER' && e.actorId ? (
												<Avatar userId={e.actorId} name={name} size="sm" />
											) : (
												<span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
													<BotIcon size={15} />
												</span>
											)}
											<div className="min-w-0 flex-1">
												<p className="text-sm leading-snug">
													<span className="font-medium">{name}</span>{' '}
													<span className="text-muted">{text}</span>
												</p>
												{detail && (
													<p
														className={cx(
															'mt-0.5 line-clamp-3 text-sm break-words',
															p.kind === 'error' && 'text-danger',
															p.mode === 'INTERRUPT' && 'text-warn',
														)}
													>
														{showMentions(detail, names)}
													</p>
												)}
												{renderExtra?.(e)}
												<div className="flex items-center gap-2">
													{status && (
														<Badge tone={status.tone}>{status.label}</Badge>
													)}
													<time
														dateTime={e.createdAt}
														title={new Date(e.createdAt).toLocaleString()}
														className="text-xs text-muted"
													>
														{timeAgo(e.createdAt)}
													</time>
												</div>
											</div>
										</div>
									</li>
								);
							})}
						</ol>
					)}
				</div>
				{showJump && (
					<Button
						size="sm"
						className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-card"
						onClick={() => {
							atBottom.current = true;
							setShowJump(false);
							virtualizer.scrollToIndex(events.length - 1, { align: 'end' });
						}}
					>
						New events ↓
					</Button>
				)}
			</div>
			{footer}
		</Pane>
	);
}
