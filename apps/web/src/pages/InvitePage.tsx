import type { SessionRole } from '@huddle/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { CenteredPage, FormError } from '../components/CenteredPage';
import { Badge, Button } from '../components/ui';
import { ApiError, api, unwrap } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/labels';
import { loginPath } from '../lib/next';

/** /invite/:token — preview the invite, then accept it (logging in first if needed). */
export function InvitePage() {
	const { token = '' } = useParams();
	const { isLoggedIn } = useAuth();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const here = `/invite/${token}`;

	const preview = useQuery({
		queryKey: ['invite', token],
		queryFn: () =>
			unwrap(api.GET('/invites/{token}', { params: { path: { token } } })),
		retry: false,
	});
	const accept = useMutation({
		mutationFn: () =>
			unwrap(
				api.POST('/invites/{token}/accept', { params: { path: { token } } }),
			),
		onSuccess: (res) => {
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			navigate(`/s/${res.sessionId}`, { replace: true });
		},
	});

	if (preview.isPending) {
		return <CenteredPage title="Opening invite…">{null}</CenteredPage>;
	}
	if (preview.isError) {
		const status = preview.error instanceof ApiError ? preview.error.status : 0;
		const title =
			status === 410
				? /revoked/i.test(preview.error.message)
					? 'This link was revoked'
					: 'This link has expired'
				: status === 404
					? "This invite link isn't valid"
					: "Couldn't open this invite";
		return (
			<CenteredPage
				title={title}
				subtitle={
					status === 410
						? 'Ask the session Owner for a new link.'
						: status === 404
							? 'Check that you copied the whole link, or ask the Owner for a new one.'
							: preview.error.message
				}
			>
				<Link
					to="/"
					className="text-sm font-medium text-accent hover:underline"
				>
					Go home
				</Link>
			</CenteredPage>
		);
	}

	const p = preview.data;
	const role = ROLE_LABEL[p.role as SessionRole];
	return (
		<CenteredPage
			title={p.sessionTitle}
			subtitle={
				<>
					{p.invitedBy} invited you to join as{' '}
					<Badge tone="accent">{role}</Badge>
				</>
			}
		>
			<div className="flex flex-col gap-3">
				<p className="text-sm text-muted">
					{p.role === 'EDITOR'
						? 'Editors can steer the agent, edit the plan and write in the document.'
						: 'Viewers can watch, ask the agent questions and leave comments.'}
				</p>
				{p.expiresAt && (
					<p className="text-xs text-muted">
						Link expires {new Date(p.expiresAt).toLocaleString()}.
					</p>
				)}
				<FormError message={accept.error?.message} />
				{isLoggedIn ? (
					<Button loading={accept.isPending} onClick={() => accept.mutate()}>
						Accept and open the session
					</Button>
				) : (
					<>
						<Button onClick={() => navigate(loginPath(here))}>
							Log in to accept
						</Button>
						<Button
							variant="secondary"
							onClick={() =>
								navigate(`/register?next=${encodeURIComponent(here)}`)
							}
						>
							Create an account
						</Button>
					</>
				)}
			</div>
		</CenteredPage>
	);
}
