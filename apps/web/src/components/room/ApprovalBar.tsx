import { ApprovalKind, can, type MembershipLike } from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { type SessionDetail, sessionKey } from '../../lib/session';
import { Button, LockIcon, Textarea } from '../ui';

type Pending = SessionDetail['pendingApprovals'][number];

const HINT: Partial<Record<ApprovalKind, string>> = {
	[ApprovalKind.OUTLINE]:
		'Review the plan. Approve to start writing, or reject with a note and the agent revises it.',
	[ApprovalKind.MARK_FINAL]:
		'Every section is written. Approve to mark the document final, or say what still needs work.',
};

/**
 * Pending approvals, above the room's panes. Approve and Reject render only for
 * people who can approve; everyone else sees what the session is waiting on.
 */
export function ApprovalBar({
	session,
	me,
}: {
	session: SessionDetail;
	me: MembershipLike;
}) {
	if (session.pendingApprovals.length === 0) return null;
	return (
		<div className="flex flex-col gap-px border-b border-line bg-line">
			{session.pendingApprovals.map((a) => (
				<ApprovalRow
					key={a.id}
					sessionId={session.id}
					approval={a}
					canApprove={can(me, 'approve')}
				/>
			))}
		</div>
	);
}

function ApprovalRow({
	sessionId,
	approval,
	canApprove,
}: {
	sessionId: string;
	approval: Pending;
	canApprove: boolean;
}) {
	const queryClient = useQueryClient();
	const [rejecting, setRejecting] = useState(false);
	const [note, setNote] = useState('');
	const noteRequired = approval.kind === ApprovalKind.MARK_FINAL;

	const resolve = useMutation({
		mutationFn: (decision: 'approve' | 'reject') =>
			unwrap(
				api.POST('/sessions/{id}/approvals/{approvalId}', {
					params: { path: { id: sessionId, approvalId: approval.id } },
					body: { decision, note: note.trim() || undefined },
				}),
			),
		onSettled: () =>
			queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) }),
	});

	return (
		<div
			className="bg-warn-soft/60 px-4 py-3"
			role="region"
			aria-label={approval.title}
		>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-1 items-start gap-2">
					<LockIcon size={15} className="mt-0.5 shrink-0 text-warn" />
					<div className="min-w-0">
						<p className="text-sm font-medium">{approval.title}</p>
						<p className="text-xs text-muted">
							{canApprove
								? (HINT[approval.kind as ApprovalKind] ??
									'The agent is waiting for your answer.')
								: 'Waiting for the Owner or an approver.'}
						</p>
					</div>
				</div>
				{canApprove && !rejecting && (
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							onClick={() => setRejecting(true)}
						>
							Reject
						</Button>
						<Button
							size="sm"
							loading={resolve.isPending && resolve.variables === 'approve'}
							onClick={() => resolve.mutate('approve')}
						>
							Approve
						</Button>
					</div>
				)}
			</div>
			{canApprove && rejecting && (
				<form
					className="mt-3 flex flex-col gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						resolve.mutate('reject');
					}}
				>
					<Textarea
						label={
							noteRequired
								? 'What still needs work?'
								: 'What should change? (optional)'
						}
						value={note}
						onChange={(e) => setNote(e.target.value)}
						required={noteRequired}
						maxLength={2000}
						autoFocus
					/>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => setRejecting(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							size="sm"
							variant="danger"
							loading={resolve.isPending}
						>
							Reject
						</Button>
					</div>
				</form>
			)}
			{resolve.error && (
				<p role="alert" className="mt-2 text-xs text-danger">
					{resolve.error.message}
				</p>
			)}
		</div>
	);
}
