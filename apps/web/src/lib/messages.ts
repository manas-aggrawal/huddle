import {
	EventType,
	MessageStatus,
	mentionPattern,
	type TimelineEventDto,
} from '@huddle/shared';
import type { BadgeTone } from '../components/ui';

export const MESSAGE_STATUS: Record<
	MessageStatus,
	{ label: string; tone: BadgeTone }
> = {
	[MessageStatus.QUEUED]: { label: 'Queued', tone: 'neutral' },
	[MessageStatus.ACKNOWLEDGED]: { label: 'Acknowledged', tone: 'accent' },
	[MessageStatus.APPLIED]: { label: 'Applied', tone: 'ok' },
	[MessageStatus.DECLINED]: { label: 'Declined', tone: 'danger' },
	[MessageStatus.ANSWERED]: { label: 'Answered', tone: 'ok' },
};

/**
 * Each message's latest status, read from the timeline: QUEUED when sent,
 * then whatever the agent's ack or answer says. Works the same on replay.
 */
export function messageStatuses(
	events: TimelineEventDto[],
): Map<string, MessageStatus> {
	const statuses = new Map<string, MessageStatus>();
	for (const e of events) {
		const p = e.payload as {
			messageId?: string;
			replyTo?: string;
			status?: string;
		};
		if (e.type === EventType.HUMAN_MESSAGE && p.messageId) {
			statuses.set(p.messageId, MessageStatus.QUEUED);
		} else if (e.type === EventType.AGENT_ACK && p.messageId && p.status) {
			statuses.set(p.messageId, p.status as MessageStatus);
		} else if (e.type === EventType.AGENT_MESSAGE && p.replyTo) {
			statuses.set(p.replyTo, MessageStatus.ANSWERED);
		}
	}
	return statuses;
}

/** "@[userId]" → "@Maya Tester" for display. Unknown ids show as "@someone". */
export function showMentions(text: string, names: Map<string, string>): string {
	return text.replace(
		mentionPattern(),
		(_, id: string) => `@${names.get(id) ?? 'someone'}`,
	);
}
