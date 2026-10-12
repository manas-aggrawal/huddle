import {
	ApprovalKind,
	ApprovalStatus,
	can,
	EventType,
	SessionRole,
} from '@huddle/shared';
import { Injectable, Logger } from '@nestjs/common';
import { SessionMember, TimelineEvent } from '@prisma/client';
import { LlmService } from '@src/llm/llm.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { CatchUpDto } from './catch-up.dto';

/** Below this many unseen events, a summary isn't worth a model call. */
const SUMMARY_MIN_EVENTS = 3;
const SUMMARY_EVENTS_MAX = 120;
const CACHE_MAX = 200;

type P = Record<string, unknown>;
const name = (v: unknown) =>
	((v as P | undefined)?.name as string | undefined) ?? undefined;

/** One line per event, for the summary prompt. */
function eventLine(e: TimelineEvent): string | null {
	const p = e.payload as P;
	const who =
		name(p.actor) ?? (e.actorType === 'AGENT' ? 'The agent' : 'Someone');
	switch (e.type) {
		case EventType.STEP_COMPLETED:
			return `The agent finished the section "${p.title}".`;
		case EventType.HUMAN_MESSAGE:
			return `${who} (${String(p.mode).toLowerCase()}): ${p.content}`;
		case EventType.AGENT_ACK:
			return `The agent replied to ${name(p.author) ?? 'someone'}: ${p.reply}`;
		case EventType.AGENT_MESSAGE:
			return `The agent said: ${p.text}`;
		case EventType.PLAN_UPDATED:
			return `${who === 'The agent' ? 'The agent' : (name(p.by) ?? who)} changed the plan${p.summary ? `: ${p.summary}` : ''}.`;
		case EventType.APPROVAL_REQUESTED:
			return `The agent asked for approval: ${p.title}.`;
		case EventType.APPROVAL_RESOLVED:
			return `${who} ${String(p.status).toLowerCase()} "${p.title}"${p.note ? ` (${p.note})` : ''}.`;
		case EventType.CONFLICT_RAISED:
			return `Conflict flagged: ${p.summary}.`;
		case EventType.CONFLICT_RESOLVED:
			return `${who} settled a conflict: ${p.resolution}.`;
		case EventType.DECISION_PINNED:
			return `${who} pinned a decision: ${p.content}.`;
		case EventType.MEMBER_JOINED:
			return `${who} joined.`;
		case EventType.HANDOFF:
			return `Ownership was handed to ${name(p.to) ?? 'someone'}.`;
		case EventType.TOOL_CALL:
			return p.tool === 'web_search'
				? `The agent searched for "${p.query}".`
				: null;
		default:
			return null;
	}
}

/**
 * "Since you were last here…": what changed after the member's lastSeenSeq.
 * The lists are read straight from the data; the short summary comes from
 * the model, once per (session, from, to).
 */
@Injectable()
export class CatchUpService {
	private readonly logger = new Logger(CatchUpService.name);
	private readonly summaries = new Map<string, string>();

	constructor(
		private readonly prisma: PrismaService,
		private readonly llm: LlmService,
	) {}

	async get(membership: SessionMember): Promise<CatchUpDto> {
		const { sessionId } = membership;
		const fromSeq = membership.lastSeenSeq;
		const session = await this.prisma.session.findUniqueOrThrow({
			where: { id: sessionId },
			select: { lastEventSeq: true, title: true, goal: true },
		});
		const toSeq = session.lastEventSeq;
		const events = await this.prisma.timelineEvent.findMany({
			where: { sessionId, seq: { gt: fromSeq, lte: toSeq } },
			orderBy: { seq: 'asc' },
		});

		const stepsCompleted = events
			.filter((e) => e.type === EventType.STEP_COMPLETED)
			.map((e) => {
				const p = e.payload as P;
				return { stepId: String(p.stepId), title: String(p.title), seq: e.seq };
			});
		const decisions = events
			.filter((e) => e.type === EventType.DECISION_PINNED)
			.map((e) => {
				const p = e.payload as P;
				return {
					decisionId: String(p.decisionId),
					content: String(p.content),
					by: name(p.actor) ?? null,
					seq: e.seq,
				};
			});

		const waitingOnYou = await this.waitingOn(membership, events);
		const summary =
			events.length >= SUMMARY_MIN_EVENTS
				? await this.summary(sessionId, fromSeq, toSeq, session, events)
				: null;

		return {
			fromSeq,
			toSeq,
			unseenCount: events.length,
			stepsCompleted,
			decisions,
			waitingOnYou,
			summary,
		};
	}

	/** Moves lastSeenSeq forward (never back, never past the newest event). */
	async markSeen(membership: SessionMember, seq: number): Promise<number> {
		const session = await this.prisma.session.findUniqueOrThrow({
			where: { id: membership.sessionId },
			select: { lastEventSeq: true },
		});
		const target = Math.min(seq, session.lastEventSeq);
		await this.prisma.sessionMember.updateMany({
			where: { id: membership.id, lastSeenSeq: { lt: target } },
			data: { lastSeenSeq: target },
		});
		const row = await this.prisma.sessionMember.findUniqueOrThrow({
			where: { id: membership.id },
			select: { lastSeenSeq: true },
		});
		return row.lastSeenSeq;
	}

	/** Approvals this member can answer, and (for the Owner) conflicts to settle. */
	private async waitingOn(membership: SessionMember, events: TimelineEvent[]) {
		const me = {
			role: membership.role as SessionRole,
			canApprove: membership.canApprove,
		};
		const seqOf = (id: string, type: string, field: string) =>
			events.find((e) => e.type === type && (e.payload as P)[field] === id)
				?.seq ?? null;
		const out: CatchUpDto['waitingOnYou'] = [];
		if (can(me, 'approve')) {
			const approvals = await this.prisma.approval.findMany({
				where: {
					sessionId: membership.sessionId,
					status: ApprovalStatus.PENDING,
				},
				orderBy: { requestedAt: 'asc' },
			});
			for (const a of approvals) {
				out.push({
					kind: 'approval',
					id: a.id,
					title: a.title,
					approvalKind: a.kind as ApprovalKind,
					seq: seqOf(a.id, EventType.APPROVAL_REQUESTED, 'approvalId'),
				});
			}
		}
		if (can(me, 'resolveConflict')) {
			const conflicts = await this.prisma.conflict.findMany({
				where: { sessionId: membership.sessionId, resolvedAt: null },
				orderBy: { createdAt: 'asc' },
			});
			for (const c of conflicts) {
				out.push({
					kind: 'conflict',
					id: c.id,
					title: c.summary,
					approvalKind: null,
					seq: seqOf(c.id, EventType.CONFLICT_RAISED, 'conflictId'),
				});
			}
		}
		return out;
	}

	private async summary(
		sessionId: string,
		fromSeq: number,
		toSeq: number,
		session: { title: string; goal: string },
		events: TimelineEvent[],
	): Promise<string | null> {
		const key = `${sessionId}:${fromSeq}:${toSeq}`;
		const cached = this.summaries.get(key);
		if (cached !== undefined) return cached;
		const lines = events
			.map(eventLine)
			.filter((l): l is string => Boolean(l))
			.slice(-SUMMARY_EVENTS_MAX);
		if (lines.length === 0) return null;
		try {
			const { text } = await this.llm.generate({
				sessionId,
				purpose: 'catch_up',
				system:
					'You write short, factual catch-up notes for teammates returning to a shared research session.',
				prompt: `Session: ${session.title}\nGoal: ${session.goal}\n\nWhat happened while they were away, oldest first:\n${lines.map((l) => `- ${l}`).join('\n')}\n\nSummarize it in 2 or 3 plain sentences: progress, decisions, and anything still open. Use people's first names. No markdown.`,
				maxOutputTokens: 250,
			});
			const summary = text.trim() || null;
			if (summary) {
				if (this.summaries.size >= CACHE_MAX) {
					this.summaries.delete(this.summaries.keys().next().value as string);
				}
				this.summaries.set(key, summary);
			}
			return summary;
		} catch (err) {
			// The lists still help without a summary (e.g. the token pool is used up).
			this.logger.warn(
				`Catch-up summary failed for ${sessionId}: ${(err as Error).message}`,
			);
			return null;
		}
	}
}
