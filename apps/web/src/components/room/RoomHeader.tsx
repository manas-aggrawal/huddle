import type { PresenceMember, SessionStatus } from '@huddle/shared';
import { useState } from 'react';
import type { ConnectionStatus } from '../../hooks/useSessionSocket';
import { STATUS_LABEL } from '../../lib/labels';
import { asRole, memberName, type SessionDetail } from '../../lib/session';
import { Can } from '../Can';
import { Badge, Button, LinkIcon } from '../ui';
import { InviteDialog } from './InviteDialog';
import { MembersPopover } from './MembersPopover';

const CONNECTION = {
	connecting: { label: 'Connecting…', tone: 'neutral' },
	live: null,
	reconnecting: { label: 'Reconnecting…', tone: 'warn' },
	offline: { label: 'Offline', tone: 'danger' },
} as const;

export function RoomHeader({
	session,
	presence,
	connection,
}: {
	session: SessionDetail;
	presence: PresenceMember[];
	connection: ConnectionStatus;
}) {
	const [inviting, setInviting] = useState(false);
	const status = STATUS_LABEL[session.status as SessionStatus];
	const owner = session.members.find((m) => m.role === 'OWNER');
	const conn = CONNECTION[connection];
	const me = { role: asRole(session.myRole), canApprove: session.myCanApprove };

	return (
		<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-3">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<h1 className="truncate text-lg font-semibold">{session.title}</h1>
					<Badge tone={status.tone}>{status.label}</Badge>
					{conn && <Badge tone={conn.tone}>{conn.label}</Badge>}
				</div>
				<p className="mt-0.5 truncate text-xs text-muted" title={session.goal}>
					{owner && <>Owner: {memberName(owner)} · </>}
					{session.goal}
				</p>
			</div>
			<div className="flex items-center gap-2">
				<MembersPopover session={session} presence={presence} />
				<Can member={me} action="invite">
					<Button
						size="sm"
						variant="secondary"
						onClick={() => setInviting(true)}
					>
						<LinkIcon />
						Invite
					</Button>
					<InviteDialog
						sessionId={session.id}
						open={inviting}
						onClose={() => setInviting(false)}
					/>
				</Can>
			</div>
		</div>
	);
}
