import { SessionStatus } from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, unwrap } from '../../lib/api';
import { type SessionDetail, sessionKey } from '../../lib/session';
import { Button, Dialog } from '../ui';

type Action = 'pause' | 'resume' | 'end';

/**
 * Owner only (rendered inside <Can action="pauseOrEnd">). Pause or resume the
 * agent, close the session for good (the doc turns read-only and it moves to
 * Done on Home), or delete it with everything in it.
 */
export function SessionControls({ session }: { session: SessionDetail }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState<'end' | 'delete' | null>(null);
	const path = { params: { path: { id: session.id } } };
	const change = useMutation({
		mutationFn: (action: Action) =>
			unwrap(api.PATCH('/sessions/{id}/status', { ...path, body: { action } })),
		onSuccess: () => {
			setConfirming(null);
			void queryClient.invalidateQueries({ queryKey: sessionKey(session.id) });
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		},
	});
	const remove = useMutation({
		mutationFn: () => unwrap(api.DELETE('/sessions/{id}', path)),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			void queryClient.invalidateQueries({ queryKey: ['notifications'] });
			navigate('/', { replace: true });
		},
	});

	const done = session.status === SessionStatus.DONE;
	const paused = session.status === SessionStatus.PAUSED;
	const pending = change.isPending ? change.variables : null;
	const error = confirming === 'delete' ? remove.error : change.error;

	return (
		<>
			{!done && (
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
					<Button
						size="sm"
						variant="ghost"
						onClick={() => setConfirming('end')}
					>
						Close session
					</Button>
				</>
			)}
			<Button
				size="sm"
				variant="ghost"
				className="text-danger"
				onClick={() => setConfirming('delete')}
			>
				Delete
			</Button>
			{change.error && !confirming && (
				<span role="alert" className="text-xs text-danger">
					{change.error.message}
				</span>
			)}
			<Dialog
				open={confirming !== null}
				onClose={() => setConfirming(null)}
				title={
					confirming === 'delete'
						? 'Delete this session?'
						: 'Close this session?'
				}
			>
				<div className="flex flex-col gap-3">
					<p className="text-sm text-muted">
						{confirming === 'delete'
							? 'The session, its document, plan, timeline and comments are deleted for everyone in it. Tokens it already used still count toward the workspace pool. This can’t be undone.'
							: 'The agent stops, pending approvals are cancelled, and the document becomes read-only for everyone. The session moves to Done on Home, where anyone in it can still read it, replay it and ask the agent questions. This can’t be undone.'}
					</p>
					{error && (
						<p role="alert" className="text-sm text-danger">
							{error.message}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button variant="ghost" onClick={() => setConfirming(null)}>
							Cancel
						</Button>
						{confirming === 'delete' ? (
							<Button
								variant="danger"
								loading={remove.isPending}
								onClick={() => remove.mutate()}
							>
								Delete session
							</Button>
						) : (
							<Button
								variant="danger"
								loading={pending === 'end'}
								onClick={() => change.mutate('end')}
							>
								Close session
							</Button>
						)}
					</div>
				</div>
			</Dialog>
		</>
	);
}
