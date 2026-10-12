import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Schemas, unwrap } from '../../lib/api';
import { Button, XIcon } from '../ui';

type CatchUp = Schemas['CatchUpDto_Output'];

/**
 * "Since you were last here…" at the top of the timeline: steps finished,
 * decisions made, what's waiting on you, and a short summary. Dismissing it
 * marks everything as seen.
 */
export function CatchUpCard({
	sessionId,
	catchUp,
	stillOpen,
	onJump,
}: {
	sessionId: string;
	catchUp: CatchUp;
	/** Ids of approvals and conflicts still open now (the card was read at load). */
	stillOpen: Set<string>;
	/** Scroll the timeline to an event. */
	onJump: (seq: number) => void;
}) {
	const [dismissed, setDismissed] = useState(false);
	const seen = useMutation({
		mutationFn: () =>
			unwrap(
				api.POST('/sessions/{id}/seen', {
					params: { path: { id: sessionId } },
					body: { seq: catchUp.toSeq },
				}),
			),
	});
	if (dismissed || catchUp.unseenCount === 0) return null;
	const firstVisit = catchUp.fromSeq === 0;

	const jump = (seq: number | null, label: string) =>
		seq ? (
			<button
				type="button"
				onClick={() => onJump(seq)}
				className="text-xs text-accent hover:underline"
			>
				{label}
			</button>
		) : null;

	return (
		<section
			aria-label="Catch-up"
			className="m-2 max-h-[45%] shrink-0 overflow-y-auto rounded-xl border border-accent/30 bg-accent-soft/50 p-3 text-sm"
		>
			<div className="flex items-start justify-between gap-2">
				<h3 className="font-semibold">
					{firstVisit
						? 'Here’s where things stand'
						: 'Since you were last here…'}
				</h3>
				<button
					type="button"
					aria-label="Dismiss"
					className="text-muted hover:text-ink"
					onClick={() => {
						setDismissed(true);
						seen.mutate();
					}}
				>
					<XIcon size={14} />
				</button>
			</div>
			{catchUp.summary && <p className="mt-1.5">{catchUp.summary}</p>}
			<ul className="mt-2 flex flex-col gap-1.5">
				{catchUp.stepsCompleted.length > 0 && (
					<li>
						<span className="font-medium">
							{catchUp.stepsCompleted.length}{' '}
							{catchUp.stepsCompleted.length === 1 ? 'step' : 'steps'} done:
						</span>{' '}
						{catchUp.stepsCompleted.map((s, i) => (
							<span key={s.stepId}>
								{i > 0 && ', '}
								{s.title} {jump(s.seq, 'Jump to')}
							</span>
						))}
					</li>
				)}
				{catchUp.decisions.map((d) => (
					<li key={d.decisionId}>
						<span className="font-medium">
							Decided{d.by && ` by ${d.by.split(' ')[0]}`}:
						</span>{' '}
						{d.content} {jump(d.seq, 'Jump to')}
					</li>
				))}
				{catchUp.waitingOnYou
					.filter((w) => stillOpen.has(w.id))
					.map((w) => (
						<li key={w.id} className="text-warn">
							<span className="font-medium">
								Waiting on you{w.kind === 'conflict' ? ' (conflict)' : ''}:
							</span>{' '}
							{w.title} {jump(w.seq, 'Jump to')}
						</li>
					))}
			</ul>
			<div className="mt-2 flex items-center justify-between">
				<span className="text-xs text-muted">
					{catchUp.unseenCount} new{' '}
					{catchUp.unseenCount === 1 ? 'event' : 'events'}
				</span>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						setDismissed(true);
						seen.mutate();
					}}
				>
					Got it
				</Button>
			</div>
		</section>
	);
}
