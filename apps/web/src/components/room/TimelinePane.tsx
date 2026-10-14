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
import {
	Avatar,
	Badge,
	BotIcon,
	Button,
	cx,
	PageIcon,
	SearchIcon,
} from '../ui';
import { actorName, describeEvent } from './describeEvent';
import { Pane } from './Pane';

/** Live timeline: virtualized, and follows new events while you're at the bottom. */
export function TimelinePane({
	events,
	names,
	footer,
	renderExtra,
	header,
	jumpTo,
	className,
}: {
	events: TimelineEventDto[];
	/** userId → display name, for showing @mentions. */
	names: Map<string, string>;
	/** The composer, pinned under the list. */
	footer?: ReactNode;
	/** Extra content under an event (e.g. an approval card). */
	renderExtra?: (event: TimelineEventDto) => ReactNode;
	/** Shown above the list (the catch-up card). */
	header?: ReactNode;
	/** Scroll to this event and flash it; `n` changes for every request. */
	jumpTo?: { seq: number; n: number } | null;
	className?: string;
}) {
	const statuses = useMemo(() => messageStatuses(events), [events]);
	const [flash, setFlash] = useState<number | null>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	const [showJump, setShowJump] = useState(false);
	const [, tick] = useState(0);
	// Rows remount as they scroll in and out, so which ones are expanded lives here.
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const toggleExpanded = (id: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});

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

	useEffect(() => {
		if (!jumpTo) return;
		const index = events.findIndex((e) => e.seq === jumpTo.seq);
		if (index === -1) return;
		atBottom.current = false;
		virtualizer.scrollToIndex(index, { align: 'center' });
		setFlash(jumpTo.seq);
		const t = setTimeout(() => setFlash(null), 1600);
		return () => clearTimeout(t);
	}, [jumpTo, events, virtualizer]);

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
			{header}
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
										className={cx(
											'absolute top-0 left-0 w-full px-3 py-2 transition-colors',
											flash === e.seq && 'bg-accent-soft',
										)}
										style={{ transform: `translateY(${item.start}px)` }}
									>
										<div className="flex gap-2.5">
											{e.actorType === 'USER' && e.actorId ? (
												<Avatar userId={e.actorId} name={name} size="sm" />
											) : (
												<span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
													{e.type === EventType.TOOL_CALL &&
													(e.payload as { tool?: string }).tool ===
														'web_search' ? (
														<SearchIcon size={14} />
													) : e.type === EventType.TOOL_CALL ? (
														<PageIcon size={14} />
													) : (
														<BotIcon size={15} />
													)}
												</span>
											)}
											<div className="min-w-0 flex-1">
												<p className="text-sm leading-snug">
													<span className="font-medium">{name}</span>{' '}
													<span className="text-muted">{text}</span>
												</p>
												{detail && (
													<ClampedText
														expanded={expanded.has(e.id)}
														onToggle={() => toggleExpanded(e.id)}
														className={cx(
															'mt-0.5 text-sm break-words whitespace-pre-line',
															p.kind === 'error' && 'text-danger',
															p.mode === 'INTERRUPT' && 'text-warn',
														)}
													>
														{showMentions(detail, names)}
													</ClampedText>
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

/**
 * Text cut to three lines, with "Read more" when (and only when) it doesn't
 * fit. The row's height changes on toggle; the virtualizer re-measures it.
 */
function ClampedText({
	children,
	expanded,
	onToggle,
	className,
}: {
	children: ReactNode;
	expanded: boolean;
	onToggle: () => void;
	className?: string;
}) {
	const ref = useRef<HTMLParagraphElement>(null);
	const [overflows, setOverflows] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || expanded) return;
		const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, [expanded]);

	return (
		<>
			<p ref={ref} className={cx(className, !expanded && 'line-clamp-3')}>
				{children}
			</p>
			{(overflows || expanded) && (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={expanded}
					className="mt-0.5 text-xs font-medium text-accent hover:underline"
				>
					{expanded ? 'Show less' : 'Read more'}
				</button>
			)}
		</>
	);
}
