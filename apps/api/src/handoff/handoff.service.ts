import {
	ActorType,
	ApprovalStatus,
	EventType,
	MessageMode,
	MessageStatus,
	NotificationType,
	SessionRole,
	StepStatus,
} from '@huddle/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { Handoff, SessionMember } from '@prisma/client';
import { LlmService } from '@src/llm/llm.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { NotificationService } from '@src/realtime/notification.service';
import { TimelineService } from '@src/timeline/timeline.service';

const fullName = (u: { firstname: string; lastname: string }) =>
	`${u.firstname} ${u.lastname}`.trim();

/**
 * Passing the Owner role on. The agent writes a briefing (goal, progress,
 * open questions, decisions, pending approvals) that the Owner can edit;
 * the roles swap in one transaction, so there's always exactly one Owner.
 */
@Injectable()
export class HandoffService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly llm: LlmService,
		private readonly notifications: NotificationService,
	) {}

	/** Drafts the briefing for `toUserId`. Nothing changes yet. */
	async preview(owner: SessionMember, toUserId: string): Promise<string> {
		const target = await this.eligible(owner, toUserId);
		const sessionId = owner.sessionId;
		const [session, steps, decisions, approvals, conflicts, questions] =
			await Promise.all([
				this.prisma.session.findUniqueOrThrow({ where: { id: sessionId } }),
				this.prisma.planStep.findMany({
					where: { sessionId },
					orderBy: { position: 'asc' },
				}),
				this.prisma.decision.findMany({
					where: { sessionId, unpinnedAt: null },
					orderBy: { pinnedAt: 'asc' },
				}),
				this.prisma.approval.findMany({
					where: { sessionId, status: ApprovalStatus.PENDING },
				}),
				this.prisma.conflict.findMany({
					where: { sessionId, resolvedAt: null },
				}),
				this.prisma.message.findMany({
					where: {
						sessionId,
						status: { in: [MessageStatus.QUEUED, MessageStatus.ACKNOWLEDGED] },
						mode: { not: MessageMode.ASK },
					},
					include: { author: { select: { firstname: true, lastname: true } } },
					orderBy: { createdAt: 'asc' },
				}),
			]);
		const status = (s: string) =>
			s === StepStatus.DONE
				? 'done'
				: s === StepStatus.IN_PROGRESS
					? 'in progress'
					: s.toLowerCase();
		const lines = [
			`Session: ${session.title}`,
			`Goal: ${session.goal}`,
			`Status: ${session.status.toLowerCase()}`,
			`Plan:\n${steps.map((s, i) => `${i + 1}. [${status(s.status)}] ${s.title}`).join('\n') || '(no plan yet)'}`,
			decisions.length
				? `Pinned decisions:\n${decisions.map((d) => `- ${d.content}`).join('\n')}`
				: 'Pinned decisions: none',
			approvals.length
				? `Waiting for approval:\n${approvals.map((a) => `- ${a.title}`).join('\n')}`
				: '',
			conflicts.length
				? `Open conflicts:\n${conflicts.map((c) => `- ${c.summary}`).join('\n')}`
				: '',
			questions.length
				? `Input not yet handled:\n${questions.map((q) => `- ${fullName(q.author)}: ${q.content}`).join('\n')}`
				: '',
		].filter(Boolean);
		const { text } = await this.llm.generate({
			sessionId,
			purpose: 'briefing',
			system:
				'You write handoff briefings for the next owner of a shared research session. Factual, short, useful.',
			prompt: `${lines.join('\n\n')}\n\nWrite a briefing for ${fullName(target.user)}, who is taking over as Owner. Cover: the goal, progress so far, decisions made, what's waiting (approvals, conflicts, unhandled input) and suggested next steps. 5 to 10 short lines, plain text.`,
			maxOutputTokens: 600,
		});
		return text.trim();
	}

	async handOff(
		owner: SessionMember,
		dto: { toUserId: string; briefing: string; note?: string },
	): Promise<Handoff> {
		const sessionId = owner.sessionId;
		await this.eligible(owner, dto.toUserId);
		return this.timeline.transaction(async (tx) => {
			// Re-checked inside the transaction: the target may have changed meanwhile.
			const target = await tx.sessionMember.findUnique({
				where: { sessionId_userId: { sessionId, userId: dto.toUserId } },
			});
			if (!target || target.role !== SessionRole.EDITOR) {
				throw new BadRequestException('Hand off to an Editor of this session');
			}
			const { count } = await tx.sessionMember.updateMany({
				where: { id: owner.id, role: SessionRole.OWNER },
				data: { role: SessionRole.EDITOR, canApprove: true },
			});
			if (count === 0)
				throw new BadRequestException('You are no longer the Owner');
			await tx.sessionMember.update({
				where: { id: target.id },
				data: { role: SessionRole.OWNER, canApprove: false },
			});
			const handoff = await tx.handoff.create({
				data: {
					sessionId,
					fromUserId: owner.userId,
					toUserId: dto.toUserId,
					briefing: dto.briefing,
					note: dto.note ?? null,
				},
			});
			const from = await this.timeline.actorSnapshot(tx, owner.userId);
			const to = await this.timeline.actorSnapshot(tx, dto.toUserId);
			await this.timeline.append(tx, sessionId, {
				type: EventType.HANDOFF,
				actorType: ActorType.USER,
				actorId: owner.userId,
				payload: {
					actor: from,
					handoffId: handoff.id,
					from,
					to,
					note: dto.note ?? null,
					briefing: dto.briefing,
				},
			});
			await this.notifications.create(tx, [
				{
					userId: dto.toUserId,
					sessionId,
					type: NotificationType.HANDOFF_RECEIVED,
					title: `${from.name} handed you the session`,
					refId: handoff.id,
				},
			]);
			return handoff;
		});
	}

	/** Only an Editor can take over: a Viewer needs promoting first, and you can't hand off to yourself. */
	private async eligible(owner: SessionMember, toUserId: string) {
		if (toUserId === owner.userId) {
			throw new BadRequestException('You already own this session');
		}
		const target = await this.prisma.sessionMember.findUnique({
			where: {
				sessionId_userId: { sessionId: owner.sessionId, userId: toUserId },
			},
			include: { user: { select: { firstname: true, lastname: true } } },
		});
		if (!target)
			throw new BadRequestException(
				'That person is not a member of this session',
			);
		if (target.role === SessionRole.VIEWER) {
			throw new BadRequestException(
				'Viewers can’t take over. Make them an Editor first.',
			);
		}
		return target;
	}
}
