import { SessionRole } from '@huddle/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Schemas, unwrap } from '../../lib/api';
import { ROLE_LABEL } from '../../lib/labels';
import { Badge, Button, CheckIcon, CopyIcon, Dialog } from '../ui';

type InviteRole = 'EDITOR' | 'VIEWER';
type Created = Schemas['CreatedInviteDto_Output'];

const EXPIRY = [
	{ label: 'Never', hours: undefined },
	{ label: '24 hours', hours: 24 },
	{ label: '7 days', hours: 24 * 7 },
] as const;

/** Owner only (the caller renders it inside <Can action="invite">). */
export function InviteDialog({
	sessionId,
	open,
	onClose,
}: {
	sessionId: string;
	open: boolean;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [role, setRole] = useState<InviteRole>(SessionRole.EDITOR);
	const [expiry, setExpiry] = useState(0);
	const [created, setCreated] = useState<Created | null>(null);
	const key = ['invites', sessionId];

	const invites = useQuery({
		queryKey: key,
		queryFn: () =>
			unwrap(
				api.GET('/sessions/{id}/invites', {
					params: { path: { id: sessionId } },
				}),
			),
		enabled: open,
	});
	const create = useMutation({
		mutationFn: () =>
			unwrap(
				api.POST('/sessions/{id}/invites', {
					params: { path: { id: sessionId } },
					body: { role, expiresInHours: EXPIRY[expiry].hours },
				}),
			),
		onSuccess: (inv) => {
			setCreated(inv);
			void queryClient.invalidateQueries({ queryKey: key });
		},
	});
	const revoke = useMutation({
		mutationFn: (inviteId: string) =>
			unwrap(
				api.DELETE('/sessions/{id}/invites/{inviteId}', {
					params: { path: { id: sessionId, inviteId } },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
	});

	return (
		<Dialog
			open={open}
			onClose={() => {
				setCreated(null);
				onClose();
			}}
			title="Invite people"
		>
			<div className="flex flex-col gap-4">
				<fieldset className="grid grid-cols-2 gap-2">
					<legend className="mb-2 text-sm font-medium">They join as</legend>
					{([SessionRole.EDITOR, SessionRole.VIEWER] as const).map((r) => (
						<label
							key={r}
							className={`cursor-pointer rounded-lg border p-3 text-sm ${role === r ? 'border-accent bg-accent-soft' : 'border-line'}`}
						>
							<input
								type="radio"
								name="role"
								value={r}
								checked={role === r}
								onChange={() => setRole(r)}
								className="sr-only"
							/>
							<span className="font-medium">{ROLE_LABEL[r]}</span>
							<span className="mt-0.5 block text-xs text-muted">
								{r === SessionRole.EDITOR
									? 'Steer the agent and edit'
									: 'Watch, ask and comment'}
							</span>
						</label>
					))}
				</fieldset>
				<label className="flex items-center justify-between gap-3 text-sm">
					<span className="font-medium">Link expires</span>
					<select
						value={expiry}
						onChange={(e) => setExpiry(Number(e.target.value))}
						className="h-9 rounded-lg border border-line bg-surface px-2 text-sm"
					>
						{EXPIRY.map((x, i) => (
							<option key={x.label} value={i}>
								{x.label}
							</option>
						))}
					</select>
				</label>
				<Button loading={create.isPending} onClick={() => create.mutate()}>
					Create {ROLE_LABEL[role].toLowerCase()} link
				</Button>
				{create.error && (
					<p className="text-sm text-danger">{create.error.message}</p>
				)}
				{created && <CopyLink url={created.url} />}

				{invites.data && invites.data.length > 0 && (
					<div>
						<h3 className="text-sm font-medium">Active links</h3>
						<p className="text-xs text-muted">
							A link is shown only once, when it's created. Revoke one to stop
							it working.
						</p>
						<ul className="mt-2 flex flex-col divide-y divide-line">
							{invites.data.map((inv) => (
								<li
									key={inv.id}
									className="flex items-center gap-2 py-2 text-sm"
								>
									<Badge
										tone={
											inv.role === SessionRole.EDITOR ? 'accent' : 'neutral'
										}
									>
										{ROLE_LABEL[inv.role]}
									</Badge>
									<span className="min-w-0 flex-1 truncate text-xs text-muted">
										Used {inv.useCount}× ·{' '}
										{inv.expiresAt
											? `expires ${new Date(inv.expiresAt).toLocaleDateString()}`
											: 'no expiry'}
									</span>
									<Button
										size="sm"
										variant="ghost"
										loading={revoke.isPending && revoke.variables === inv.id}
										onClick={() => revoke.mutate(inv.id)}
									>
										Revoke
									</Button>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</Dialog>
	);
}

function CopyLink({ url }: { url: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
			<input
				readOnly
				value={url}
				onFocus={(e) => e.target.select()}
				className="min-w-0 flex-1 bg-transparent text-xs outline-none"
				aria-label="Invite link"
			/>
			<Button
				size="sm"
				variant="secondary"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(url);
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					} catch {
						// Clipboard blocked: the field is selectable for a manual copy.
					}
				}}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
				{copied ? 'Copied' : 'Copy'}
			</Button>
		</div>
	);
}
