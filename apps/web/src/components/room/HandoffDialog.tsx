import { SessionRole } from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { memberName, type SessionDetail, sessionKey } from '../../lib/session';
import { Button, Dialog, Textarea } from '../ui';

/**
 * Owner only (rendered inside <Can action="handOff">). Pick an Editor, let the
 * agent draft a briefing, edit it, and hand the session over.
 */
export function HandoffDialog({
	session,
	open,
	onClose,
}: {
	session: SessionDetail;
	open: boolean;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const editors = session.members.filter((m) => m.role === SessionRole.EDITOR);
	const [picked, setPicked] = useState('');
	// The dialog is mounted before anyone may be an Editor, so fall back to the
	// first Editor now rather than whoever was first when it mounted.
	const to = editors.some((m) => m.userId === picked)
		? picked
		: (editors[0]?.userId ?? '');
	const [briefing, setBriefing] = useState('');
	const [note, setNote] = useState('');
	const path = { params: { path: { id: session.id } } };

	const draft = useMutation({
		mutationFn: () =>
			unwrap(
				api.POST('/sessions/{id}/handoff/preview', {
					...path,
					body: { toUserId: to },
				}),
			),
		onSuccess: (r) => setBriefing(r.briefing),
	});
	const handOff = useMutation({
		mutationFn: () =>
			unwrap(
				api.POST('/sessions/{id}/handoff', {
					...path,
					body: {
						toUserId: to,
						briefing: briefing.trim(),
						note: note.trim() || undefined,
					},
				}),
			),
		onSuccess: () => {
			onClose();
			void queryClient.invalidateQueries({ queryKey: sessionKey(session.id) });
		},
	});

	return (
		<Dialog open={open} onClose={onClose} title="Hand off the session">
			{editors.length === 0 ? (
				<p className="text-sm text-muted">
					Only an Editor can take over. Invite someone as an Editor, or make a
					Viewer an Editor from the members list.
				</p>
			) : (
				<form
					className="flex flex-col gap-3"
					onSubmit={(e) => {
						e.preventDefault();
						if (briefing.trim()) handOff.mutate();
					}}
				>
					<label className="flex flex-col gap-1.5 text-sm font-medium">
						New Owner
						<select
							value={to}
							onChange={(e) => {
								setPicked(e.target.value);
								setBriefing('');
							}}
							className="h-10 rounded-lg border border-line bg-surface px-3 text-sm font-normal outline-none focus:border-focus"
						>
							{editors.map((m) => (
								<option key={m.userId} value={m.userId}>
									{memberName(m)}
								</option>
							))}
						</select>
					</label>
					<p className="text-xs text-muted">
						You’ll stay on as an Editor who can approve.
					</p>
					{briefing ? (
						<Textarea
							label="Briefing (edit before sending)"
							value={briefing}
							onChange={(e) => setBriefing(e.target.value)}
							rows={8}
							maxLength={8000}
							required
						/>
					) : (
						<Button
							type="button"
							variant="secondary"
							loading={draft.isPending}
							onClick={() => draft.mutate()}
						>
							Draft a briefing
						</Button>
					)}
					<Textarea
						label="Note (optional)"
						value={note}
						onChange={(e) => setNote(e.target.value)}
						maxLength={2000}
						rows={2}
					/>
					{(draft.error || handOff.error) && (
						<p role="alert" className="text-sm text-danger">
							{(draft.error ?? handOff.error)?.message}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button
							type="submit"
							loading={handOff.isPending}
							disabled={!briefing.trim()}
						>
							Hand off
						</Button>
					</div>
				</form>
			)}
		</Dialog>
	);
}
