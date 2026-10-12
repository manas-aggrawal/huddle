import { EventType, type TimelineEventDto } from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { sessionKey } from '../../lib/session';
import { Avatar, Badge, Button, CheckIcon, Dialog, Textarea } from '../ui';

interface Side {
	messageId: string;
	content: string;
	author: { id: string; name: string };
}

/** How each conflict was settled, from CONFLICT_RESOLVED events. */
export function conflictResolutions(events: TimelineEventDto[]) {
	const out = new Map<string, { resolution: string; by: string | null }>();
	for (const e of events) {
		if (e.type !== EventType.CONFLICT_RESOLVED) continue;
		const p = e.payload as {
			conflictId?: string;
			resolution?: string;
			actor?: { name?: string };
		};
		if (p.conflictId)
			out.set(p.conflictId, {
				resolution: p.resolution ?? '',
				by: p.actor?.name ?? null,
			});
	}
	return out;
}

/**
 * Under a CONFLICT_RAISED row: both sides with who said them. The Owner gets
 * Resolve; everyone else sees that it's waiting for the Owner.
 */
export function ConflictCard({
	sessionId,
	conflictId,
	sides,
	stepTitle,
	open,
	resolved,
	canResolve,
}: {
	sessionId: string;
	conflictId: string;
	sides: Side[];
	stepTitle: string | null;
	/** Still open on the server. */
	open: boolean;
	resolved?: { resolution: string; by: string | null };
	canResolve: boolean;
}) {
	const [resolving, setResolving] = useState(false);
	return (
		<div className="mt-2 rounded-lg border border-warn/40 bg-warn-soft/40 p-2.5">
			<ul className="flex flex-col gap-2">
				{sides.map((s) => (
					<li key={s.messageId} className="flex gap-2">
						<Avatar userId={s.author.id} name={s.author.name} size="sm" />
						<div className="min-w-0 text-sm">
							<span className="font-medium">{s.author.name.split(' ')[0]}</span>
							<p className="break-words text-ink">{s.content}</p>
						</div>
					</li>
				))}
			</ul>
			<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
				{stepTitle && <span>Holds “{stepTitle}”.</span>}
				{resolved ? (
					<span className="flex flex-wrap items-center gap-2">
						<Badge tone="ok">
							<CheckIcon size={11} />
							Settled{resolved.by && ` by ${resolved.by.split(' ')[0]}`}
						</Badge>
						<span className="text-ink">“{resolved.resolution}”</span>
					</span>
				) : !open ? null : canResolve ? (
					<Button size="sm" onClick={() => setResolving(true)}>
						Resolve
					</Button>
				) : (
					<span>Waiting for the Owner to decide.</span>
				)}
			</div>
			{canResolve && (
				<ResolveDialog
					sessionId={sessionId}
					conflictId={conflictId}
					sides={sides}
					open={resolving}
					onClose={() => setResolving(false)}
				/>
			)}
		</div>
	);
}

function ResolveDialog({
	sessionId,
	conflictId,
	sides,
	open,
	onClose,
}: {
	sessionId: string;
	conflictId: string;
	sides: Side[];
	open: boolean;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [text, setText] = useState('');
	const resolve = useMutation({
		mutationFn: () =>
			unwrap(
				api.POST('/sessions/{id}/conflicts/{conflictId}/resolve', {
					params: { path: { id: sessionId, conflictId } },
					body: { resolution: text.trim() },
				}),
			),
		onSuccess: () => {
			onClose();
			void queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) });
		},
	});
	return (
		<Dialog open={open} onClose={onClose} title="Resolve the conflict">
			<form
				className="flex flex-col gap-3"
				onSubmit={(e) => {
					e.preventDefault();
					if (text.trim()) resolve.mutate();
				}}
			>
				<p className="text-sm text-muted">
					Pick a side or write what the team goes with. It’s pinned as a
					decision, and the agent follows it.
				</p>
				<div className="flex flex-wrap gap-2">
					{sides.map((s) => (
						<Button
							key={s.messageId}
							type="button"
							size="sm"
							variant="secondary"
							onClick={() => setText(s.content)}
						>
							Go with {s.author.name.split(' ')[0]}
						</Button>
					))}
				</div>
				<Textarea
					label="Decision"
					value={text}
					onChange={(e) => setText(e.target.value)}
					maxLength={1000}
					required
				/>
				{resolve.error && (
					<p role="alert" className="text-sm text-danger">
						{resolve.error.message}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button
						type="submit"
						loading={resolve.isPending}
						disabled={!text.trim()}
					>
						Resolve
					</Button>
				</div>
			</form>
		</Dialog>
	);
}
