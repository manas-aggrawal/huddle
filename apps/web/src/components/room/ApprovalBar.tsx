import {
	ApprovalKind,
	ApprovalStatus,
	can,
	EventType,
	type MembershipLike,
	type TimelineEventDto,
} from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { type SessionDetail, sessionKey } from '../../lib/session';
import { Badge, Button, CheckIcon, LockIcon, Textarea } from '../ui';

type Pending = SessionDetail['pendingApprovals'][number];

const HINT: Partial<Record<ApprovalKind, string>> = {
	[ApprovalKind.OUTLINE]:
		'Review the plan. Approve to start writing, or reject with a note and the agent revises it.',
	[ApprovalKind.MARK_FINAL]:
		'Every section is written. Approve to mark the document final, or say what still needs work.',
	[ApprovalKind.CUSTOM]:
		'This step needs a go-ahead. The agent works on other steps meanwhile.',
	[ApprovalKind.REWRITE_HUMAN_TEXT]:
		'The agent wants to change text a person wrote. Compare before and after.',
	[ApprovalKind.BUDGET]:
		'The session reached its token cap. Approve to give it more.',
};

/** Approve / Reject (with a note), for people who can approve. */
function ApprovalActions({
	sessionId,
	approval,
	compact = false,
}: {
	sessionId: string;
	approval: { id: string; kind: string };
	compact?: boolean;
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
		<div className={compact ? 'mt-2' : undefined}>
			{!rejecting ? (
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
			) : (
				<form
					className="mt-2 flex w-full flex-col gap-2"
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
	const canApprove = can(me, 'approve');
	return (
		<div className="flex flex-col gap-px border-b border-line bg-line">
			{session.pendingApprovals.map((a: Pending) => (
				<div
					key={a.id}
					className="flex flex-wrap items-start gap-x-4 gap-y-2 bg-warn-soft/60 px-4 py-3"
					role="region"
					aria-label={a.title}
				>
					<div className="flex min-w-0 flex-1 items-start gap-2">
						<LockIcon size={15} className="mt-0.5 shrink-0 text-warn" />
						<div className="min-w-0">
							<p className="text-sm font-medium">{a.title}</p>
							<p className="text-xs text-muted">
								{canApprove
									? (HINT[a.kind as ApprovalKind] ??
										'The agent is waiting for your answer.')
									: 'Waiting for the Owner or an approver.'}
							</p>
						</div>
					</div>
					{canApprove && (
						<ApprovalActions sessionId={session.id} approval={a} />
					)}
				</div>
			))}
		</div>
	);
}

/** How each approval ended, from the timeline (APPROVAL_RESOLVED events). */
export function approvalOutcomes(events: TimelineEventDto[]) {
	const outcomes = new Map<
		string,
		{ status: string; by: string | null; note: string | null }
	>();
	for (const e of events) {
		if (e.type !== EventType.APPROVAL_RESOLVED) continue;
		const p = e.payload as {
			approvalId?: string;
			status?: string;
			note?: string | null;
			resolvedBy?: { name?: string };
		};
		if (p.approvalId)
			outcomes.set(p.approvalId, {
				status: p.status ?? '',
				by: p.resolvedBy?.name ?? null,
				note: p.note ?? null,
			});
	}
	return outcomes;
}

/** The card under an APPROVAL_REQUESTED row in the timeline. */
export function ApprovalCard({
	sessionId,
	approvalId,
	kind,
	pending,
	outcome,
	canApprove,
	onDiscuss,
}: {
	sessionId: string;
	approvalId: string;
	kind: string;
	/** Still pending on the server (cancelled ones aren't). */
	pending: boolean;
	outcome?: { status: string; by: string | null; note: string | null };
	canApprove: boolean;
	onDiscuss: () => void;
}) {
	if (outcome) {
		const approved = outcome.status === ApprovalStatus.APPROVED;
		return (
			<div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
				<Badge tone={approved ? 'ok' : 'danger'}>
					{approved && <CheckIcon size={11} />}
					{approved ? 'Approved' : 'Rejected'}
					{outcome.by && ` by ${outcome.by.split(' ')[0]}`}
				</Badge>
				{outcome.note && <span className="text-muted">“{outcome.note}”</span>}
			</div>
		);
	}
	if (!pending) {
		return (
			<div className="mt-1.5">
				<Badge>No longer needed</Badge>
			</div>
		);
	}
	return (
		<div className="mt-2 rounded-lg border border-line bg-surface-2 p-2.5">
			<p className="text-xs text-muted">
				{canApprove
					? (HINT[kind as ApprovalKind] ?? 'Waiting for your answer.')
					: 'Waiting for the Owner or an approver.'}
			</p>
			<div className="mt-2 flex flex-wrap items-start gap-2">
				{canApprove && (
					<ApprovalActions
						sessionId={sessionId}
						approval={{ id: approvalId, kind }}
					/>
				)}
				<Button size="sm" variant="ghost" onClick={onDiscuss}>
					Discuss
				</Button>
			</div>
		</div>
	);
}
