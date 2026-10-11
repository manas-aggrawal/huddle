import { type PresenceMember, SessionRole } from '@huddle/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../lib/api';
import { ROLE_LABEL } from '../../lib/labels';
import {
	asRole,
	type Member,
	memberName,
	type SessionDetail,
	sessionKey,
} from '../../lib/session';
import { Can } from '../Can';
import { Avatar, Button, Popover, Switch } from '../ui';

/** The avatars in the header; click to see every member. The Owner can change roles here. */
export function MembersPopover({
	session,
	presence,
}: {
	session: SessionDetail;
	presence: PresenceMember[];
}) {
	const online = new Map(presence.map((p) => [p.userId, p]));
	const me = { role: asRole(session.myRole), canApprove: session.myCanApprove };
	// Online people first, in the order they appear in presence; then a count of the rest.
	const shown = presence.slice(0, 5);
	const offline = session.members.length - presence.length;

	return (
		<Popover
			label="Members"
			trigger={
				<span className="flex items-center gap-2 rounded-full px-1 py-0.5 hover:bg-surface-2">
					<span className="flex -space-x-1.5">
						{shown.map((p) => (
							<Avatar
								key={p.userId}
								userId={p.userId}
								name={p.name}
								size="sm"
								dashed={p.role === SessionRole.VIEWER}
								typing={p.typing}
								className="ring-2 ring-surface rounded-full"
							/>
						))}
					</span>
					<span className="text-xs text-muted">
						{presence.length} online
						{offline > 0 ? ` · ${session.members.length} total` : ''}
					</span>
				</span>
			}
		>
			<h3 className="px-1 text-sm font-semibold">Members</h3>
			<ul className="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto">
				{session.members.map((m) => (
					<MemberRow
						key={m.userId}
						sessionId={session.id}
						member={m}
						online={online.get(m.userId)}
						me={me}
					/>
				))}
			</ul>
		</Popover>
	);
}

function MemberRow({
	sessionId,
	member,
	online,
	me,
}: {
	sessionId: string;
	member: Member;
	online: PresenceMember | undefined;
	me: { role: SessionRole; canApprove: boolean };
}) {
	const queryClient = useQueryClient();
	const [confirmRemove, setConfirmRemove] = useState(false);
	const role = asRole(member.role);
	const name = memberName(member);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) });

	const update = useMutation({
		mutationFn: (body: { role?: 'EDITOR' | 'VIEWER'; canApprove?: boolean }) =>
			unwrap(
				api.PATCH('/sessions/{id}/members/{userId}', {
					params: { path: { id: sessionId, userId: member.userId } },
					body,
				}),
			),
		onSuccess: refresh,
	});
	const remove = useMutation({
		mutationFn: () =>
			unwrap(
				api.DELETE('/sessions/{id}/members/{userId}', {
					params: { path: { id: sessionId, userId: member.userId } },
				}),
			),
		onSuccess: refresh,
	});
	const error = update.error?.message ?? remove.error?.message;

	return (
		<li className="rounded-lg px-1 py-1.5 hover:bg-surface-2/60">
			<div className="flex items-center gap-2">
				<Avatar
					userId={member.userId}
					name={name}
					size="sm"
					dashed={role === SessionRole.VIEWER}
				/>
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm">
						{name}
						{online && (
							<span
								className="ml-1.5 inline-block size-1.5 rounded-full bg-ok align-middle"
								title="Online"
							/>
						)}
					</p>
					<p className="text-xs text-muted">@{member.username}</p>
				</div>
				{role === SessionRole.OWNER ? (
					<span className="text-xs font-medium text-muted">Owner</span>
				) : (
					<>
						{/* Only the Owner can change roles; everyone else just sees the label. */}
						<Can member={me} action="changeRoles">
							<select
								aria-label={`Role for ${name}`}
								value={role}
								disabled={update.isPending}
								onChange={(e) =>
									update.mutate({ role: e.target.value as 'EDITOR' | 'VIEWER' })
								}
								className="h-7 rounded-md border border-line bg-surface px-1.5 text-xs"
							>
								<option value={SessionRole.EDITOR}>{ROLE_LABEL.EDITOR}</option>
								<option value={SessionRole.VIEWER}>{ROLE_LABEL.VIEWER}</option>
							</select>
						</Can>
						{me.role !== SessionRole.OWNER && (
							<span className="text-xs text-muted">{ROLE_LABEL[role]}</span>
						)}
					</>
				)}
			</div>

			<Can member={me} action="changeRoles">
				{role !== SessionRole.OWNER && (
					<div className="mt-1.5 flex items-center justify-between gap-2 pl-9">
						{/* "Can approve" exists only for Editors: Owners always can, Viewers never can. */}
						{role === SessionRole.EDITOR ? (
							<span className="flex items-center gap-2 text-xs text-muted">
								<Switch
									checked={member.canApprove}
									busy={update.isPending}
									label={`Allow ${name} to approve`}
									onChange={(canApprove) => update.mutate({ canApprove })}
								/>
								Can approve
							</span>
						) : (
							<span />
						)}
						{confirmRemove ? (
							<span className="flex items-center gap-1">
								<Button
									size="sm"
									variant="danger"
									loading={remove.isPending}
									onClick={() => remove.mutate()}
								>
									Remove
								</Button>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setConfirmRemove(false)}
								>
									Cancel
								</Button>
							</span>
						) : (
							<button
								type="button"
								onClick={() => setConfirmRemove(true)}
								className="text-xs text-muted hover:text-danger"
							>
								Remove
							</button>
						)}
					</div>
				)}
			</Can>
			{error && <p className="mt-1 pl-9 text-xs text-danger">{error}</p>}
		</li>
	);
}
