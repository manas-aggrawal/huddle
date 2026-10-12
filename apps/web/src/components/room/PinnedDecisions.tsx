import { DecisionLimits } from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { type SessionDetail, sessionKey } from '../../lib/session';
import { Button, cx } from '../ui';

type Decision = SessionDetail['decisions'][number];

const ORIGIN: Record<Decision['origin'], string> = {
	manual: 'pinned by',
	approval: 'from an answer by',
	conflict: 'settled by',
};

/**
 * The session's shared memory, under the plan. Editors and the Owner can pin
 * and unpin; everyone sees the list (the agent follows it).
 */
export function PinnedDecisions({
	sessionId,
	decisions,
	canPin,
}: {
	sessionId: string;
	decisions: Decision[];
	canPin: boolean;
}) {
	const queryClient = useQueryClient();
	const [text, setText] = useState('');
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) });

	const pin = useMutation({
		mutationFn: (content: string) =>
			unwrap(
				api.POST('/sessions/{id}/decisions', {
					params: { path: { id: sessionId } },
					body: { content },
				}),
			),
		onSuccess: () => {
			setText('');
			void refresh();
		},
	});
	const unpin = useMutation({
		mutationFn: (decisionId: string) =>
			unwrap(
				api.DELETE('/sessions/{id}/decisions/{decisionId}', {
					params: { path: { id: sessionId, decisionId } },
				}),
			),
		onSettled: refresh,
	});

	if (decisions.length === 0 && !canPin) return null;
	return (
		<div className="border-t border-line p-3">
			<h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
				Pinned
			</h3>
			{decisions.length === 0 ? (
				<p className="text-xs text-muted">
					Nothing pinned yet. Pin what the team agrees on; the agent follows it.
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{decisions.map((d) => (
						<li
							key={d.id}
							className="group rounded-lg bg-surface-2 px-2.5 py-2 text-sm"
						>
							<p className="break-words">{d.content}</p>
							<div className="mt-0.5 flex items-center justify-between gap-2">
								<span className="text-xs text-muted">
									{d.createdBy
										? `${ORIGIN[d.origin]} ${d.createdBy.name.split(' ')[0]}`
										: 'pinned by the agent'}
								</span>
								{canPin && (
									<button
										type="button"
										className={cx(
											'text-xs text-muted hover:text-danger',
											'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
										)}
										onClick={() => unpin.mutate(d.id)}
										disabled={unpin.isPending}
									>
										Unpin
									</button>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
			{canPin && (
				<form
					className="mt-2 flex gap-1.5"
					onSubmit={(e) => {
						e.preventDefault();
						if (text.trim()) pin.mutate(text.trim());
					}}
				>
					<input
						aria-label="Pin a decision"
						value={text}
						onChange={(e) => setText(e.target.value)}
						maxLength={DecisionLimits.CONTENT_MAX}
						placeholder="Pin a decision…"
						className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-sm outline-none placeholder:text-muted focus:border-focus"
					/>
					<Button
						type="submit"
						size="sm"
						variant="secondary"
						loading={pin.isPending}
						disabled={!text.trim()}
					>
						Pin
					</Button>
				</form>
			)}
			{(pin.error || unpin.error) && (
				<p role="alert" className="mt-1 text-xs text-danger">
					{(pin.error ?? unpin.error)?.message}
				</p>
			)}
		</div>
	);
}
