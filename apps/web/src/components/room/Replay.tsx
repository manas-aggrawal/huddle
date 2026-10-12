import type { TimelineEventDto } from '@huddle/shared';
import { useEffect, useState } from 'react';
import { Button } from '../ui';
import { actorName, describeEvent } from './describeEvent';

/**
 * For a finished session: step through the timeline one event at a time.
 * Each step scrolls to and highlights that event.
 */
export function Replay({
	events,
	onShow,
}: {
	events: TimelineEventDto[];
	onShow: (seq: number) => void;
}) {
	// Starts at the newest event and only moves the timeline once you use it.
	const [picked, setIndex] = useState<number | null>(null);
	const [playing, setPlaying] = useState(false);
	const index = picked ?? events.length - 1;
	const event = events[index];

	useEffect(() => {
		if (!playing) return;
		if (index >= events.length - 1) {
			setPlaying(false);
			return;
		}
		const t = setTimeout(() => setIndex(index + 1), 700);
		return () => clearTimeout(t);
	}, [playing, index, events.length]);

	useEffect(() => {
		if (event && picked !== null) onShow(event.seq);
	}, [event, picked, onShow]);

	if (events.length === 0) return null;
	const { text } = event ? describeEvent(event) : { text: '' };
	return (
		<section
			aria-label="Replay"
			className="m-2 shrink-0 rounded-xl border border-line bg-surface-2 p-3 text-sm"
		>
			<div className="flex items-center justify-between gap-2">
				<h3 className="font-semibold">Replay</h3>
				<span className="text-xs text-muted">
					{index + 1} / {events.length}
				</span>
			</div>
			<input
				type="range"
				aria-label="Timeline position"
				min={0}
				max={events.length - 1}
				value={index}
				onChange={(e) => {
					setPlaying(false);
					setIndex(Number(e.target.value));
				}}
				className="mt-2 w-full accent-[var(--accent)]"
			/>
			<div className="mt-1 flex items-center justify-between gap-2">
				<p className="min-w-0 truncate text-xs text-muted">
					{event && (
						<>
							<span className="font-medium text-ink">{actorName(event)}</span>{' '}
							{text}
						</>
					)}
				</p>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => {
						if (index >= events.length - 1) setIndex(0);
						setPlaying((p) => !p);
					}}
				>
					{playing ? 'Pause' : 'Play'}
				</Button>
			</div>
		</section>
	);
}
