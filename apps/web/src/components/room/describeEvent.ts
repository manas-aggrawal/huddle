import { EventType, type TimelineEventDto } from '@huddle/shared';
import { ROLE_LABEL } from '../../lib/labels';

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const nameOf = (v: unknown) => str((v as P | undefined)?.name);
const roleLabel = (v: unknown) =>
	ROLE_LABEL[v as keyof typeof ROLE_LABEL] ?? str(v)?.toLowerCase() ?? '';

/** Who did it, as shown next to the avatar. */
export function actorName(e: TimelineEventDto): string {
	return (
		nameOf(e.payload.actor) ??
		(e.actorType === 'AGENT'
			? 'Agent'
			: e.actorType === 'SYSTEM'
				? 'Huddle'
				: 'Someone')
	);
}

/**
 * One line describing an event, read from its payload snapshot. Unknown or
 * newer shapes fall back to the event type, so the timeline never breaks.
 */
export function describeEvent(e: TimelineEventDto): {
	text: string;
	detail?: string;
} {
	const p = e.payload as P;
	switch (e.type) {
		case EventType.SESSION_CREATED:
			return { text: 'created the session', detail: str(p.goal) };
		case EventType.STATUS_CHANGED: {
			const action = str(p.action);
			return {
				text:
					action === 'pause'
						? 'paused the session'
						: action === 'resume'
							? 'resumed the session'
							: action === 'end'
								? 'ended the session'
								: 'changed the status',
			};
		}
		case EventType.MEMBER_JOINED:
			return { text: `joined as ${roleLabel(p.role)}` };
		case EventType.MEMBER_REMOVED:
			return { text: `removed ${nameOf(p.member) ?? 'a member'}` };
		case EventType.ROLE_CHANGED: {
			const from = (p.from ?? {}) as P;
			const to = (p.to ?? {}) as P;
			const who = nameOf(p.member) ?? 'a member';
			if (p.via === 'invite')
				return { text: `became ${roleLabel(to.role)} through an invite` };
			if (from.role !== to.role)
				return { text: `made ${who} ${roleLabel(to.role)}` };
			return {
				text: to.canApprove
					? `allowed ${who} to approve`
					: `stopped ${who} from approving`,
			};
		}
		case EventType.HUMAN_MESSAGE: {
			const mode = str(p.mode);
			const anchor = p.anchor as P | null | undefined;
			return {
				text:
					mode === 'INTERRUPT'
						? 'interrupted the agent'
						: mode === 'ASK'
							? 'asked'
							: mode === 'COMMENT'
								? `commented on “${str(anchor?.quote)?.slice(0, 60) ?? 'the doc'}”`
								: 'suggested',
				detail: str(p.content),
			};
		}
		case EventType.AGENT_MESSAGE: {
			const to = nameOf(p.to);
			return {
				text: to
					? `answered ${to}`
					: p.kind === 'error'
						? 'ran into a problem'
						: 'said',
				detail: str(p.text) ?? str(p.content),
			};
		}
		case EventType.AGENT_ACK: {
			const who = nameOf(p.author);
			return {
				text: who ? `replied to ${who}` : 'acknowledged a message',
				detail: str(p.reply),
			};
		}
		case EventType.STEP_STARTED:
			return { text: 'started a step', detail: str(p.title) };
		case EventType.STEP_COMPLETED:
			return { text: 'finished a step', detail: str(p.title) };
		case EventType.PLAN_UPDATED: {
			const diff = (p.diff ?? {}) as { added?: unknown; removed?: unknown };
			const added = Array.isArray(diff.added) ? diff.added.map(String) : [];
			if (p.reason === 'outline')
				return { text: 'drafted an outline', detail: added.join(' · ') };
			if (p.reason === 'revised')
				return { text: 'revised the outline', detail: added.join(' · ') };
			const by = nameOf(p.by);
			if (p.reason === 'interrupt')
				return {
					text: by ? `replanned after ${by}’s interrupt` : 'replanned',
					detail: str(p.summary),
				};
			return {
				text: by ? `updated the plan for ${by}` : 'updated the plan',
				detail: str(p.summary),
			};
		}
		case EventType.TOOL_CALL:
			return {
				text:
					str(p.tool) === 'web_search'
						? 'searched the web'
						: str(p.tool) === 'read_page'
							? 'read a page'
							: 'used a tool',
				detail: str(p.query) ?? str(p.url),
			};
		case EventType.APPROVAL_REQUESTED:
			return { text: 'asked for approval', detail: str(p.title) };
		case EventType.APPROVAL_RESOLVED:
			return {
				text:
					str(p.status) === 'APPROVED'
						? 'approved'
						: str(p.status) === 'REJECTED'
							? 'rejected'
							: 'resolved an approval',
				detail: str(p.title),
			};
		case EventType.CONFLICT_RAISED:
			return { text: 'flagged a conflict', detail: str(p.summary) };
		case EventType.CONFLICT_RESOLVED:
			return { text: 'resolved a conflict', detail: str(p.resolution) };
		case EventType.DECISION_PINNED:
			return { text: 'pinned a decision', detail: str(p.content) };
		case EventType.HANDOFF:
			return { text: `handed the session to ${nameOf(p.to) ?? 'someone'}` };
		case EventType.MODEL_CHANGED:
			return { text: 'changed the model', detail: str(p.modelId) };
		case EventType.BUDGET_WARNING:
			return { text: 'warned that the budget is running low' };
		case EventType.DOC_EDITED:
			return {
				text: `edited ${str(p.sectionTitle) ? `“${str(p.sectionTitle)}”` : 'the document'}`,
			};
		default:
			// A type added after this build: show its name rather than nothing.
			return { text: String(e.type).toLowerCase().replaceAll('_', ' ') };
	}
}
