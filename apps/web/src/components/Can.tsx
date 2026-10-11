import { can, type SessionAction, type SessionRole } from '@huddle/shared';
import type { ReactNode } from 'react';

/**
 * Renders its children only if the member's role allows the action.
 * "Hide, don't disable": controls a role can never use aren't shown at all.
 * The API still enforces every rule.
 */
export function Can({
	member,
	action,
	children,
}: {
	member: { role: SessionRole; canApprove?: boolean } | null | undefined;
	action: SessionAction;
	children: ReactNode;
}) {
	return member && can(member, action) ? children : null;
}
