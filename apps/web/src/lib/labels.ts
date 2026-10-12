import { AgentState, SessionRole, SessionStatus } from '@huddle/shared';
import type { BadgeTone } from '../components/ui';

export const STATUS_LABEL: Record<
	SessionStatus,
	{ label: string; tone: BadgeTone }
> = {
	[SessionStatus.PLANNING]: { label: 'Planning', tone: 'accent' },
	[SessionStatus.RUNNING]: { label: 'Running', tone: 'ok' },
	[SessionStatus.WAITING]: { label: 'Waiting on you', tone: 'warn' },
	[SessionStatus.PAUSED]: { label: 'Paused', tone: 'neutral' },
	[SessionStatus.DONE]: { label: 'Done', tone: 'neutral' },
};

/** What the agent is doing, for the header. Idle shows nothing. */
export const AGENT_LABEL: Record<AgentState, string | null> = {
	[AgentState.IDLE]: null,
	[AgentState.THINKING]: 'Thinking…',
	[AgentState.RESEARCHING]: 'Researching…',
	[AgentState.WRITING]: 'Writing…',
};

export const ROLE_LABEL: Record<SessionRole, string> = {
	[SessionRole.OWNER]: 'Owner',
	[SessionRole.EDITOR]: 'Editor',
	[SessionRole.VIEWER]: 'Viewer',
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday"… */
export function timeAgo(iso: string, now = Date.now()): string {
	const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
	const abs = Math.abs(seconds);
	if (abs < 45) return 'just now';
	if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
	if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
	return rtf.format(Math.round(seconds / 86_400), 'day');
}
