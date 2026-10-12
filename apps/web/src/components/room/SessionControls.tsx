import { SessionStatus } from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { type SessionDetail, sessionKey } from '../../lib/session';
import { Button, Dialog } from '../ui';

type Action = 'pause' | 'resume' | 'end';

/**
 * Owner only (rendered inside <Can action="pauseOrEnd">). Pause or resume the
 * agent, or close the session for good: the doc turns read-only and it moves
 * to Done on Home.
 */
export function SessionControls({ session }: { session: SessionDetail }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const change = useMutation({
		mutationFn: (action: Action) =>
			unwrap(
				api.PATCH('/sessions/{id}/status', {
					params: { path: { id: session.id } },
					body: { action },
				}),
			),
		onSuccess: () => {
			setConfirming(false);
			void queryClient.invalidateQueries({ queryKey: sessionKey(session.id) });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});

	if (session.status === SessionStatus.DONE) return null;
	const paused = session.status === SessionStatus.PAUSED;
	const pending = change.isPending ? change.variables : null;

	return (
		<>
			<Button
				size="sm"
				variant="ghost"
				loading={pending === 'pause' || pending === 'resume'}
				onClick={() => change.mutate(paused ? 'resume' : 'pause')}
				title={
					paused
						? 'Let the agent carry on from where it stopped'
						: 'Stop the agent for now; you can resume later'
				}
			>
				{paused ? 'Resume' : 'Pause'}
			</Button>
			<Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
				Close session
			</Button>
			{change.error && !confirming && (
				<span role="alert" className="text-xs text-danger">
					{change.error.message}
				</span>
			)}
			<Dialog
				open={confirming}
				onClose={() => setConfirming(false)}
				title="Close this session?"
			>
				<div className="flex flex-col gap-3">
					<p className="text-sm text-muted">
						The agent stops, pending approvals are cancelled, and the document
						becomes read-only for everyone. The session moves to Done on Home,
						where anyone in it can still read it, replay it and ask the agent
						questions. This can’t be undone.
					</p>
					{change.error && (
						<p role="alert" className="text-sm text-danger">
							{change.error.message}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
						<Button
							variant="danger"
							loading={pending === 'end'}
							onClick={() => change.mutate('end')}
						>
							Close session
						</Button>
					</div>
				</div>
			</Dialog>
		</>
	);
}
