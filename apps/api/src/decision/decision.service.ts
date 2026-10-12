import { ActorType, EventType } from '@huddle/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SessionMember } from '@prisma/client';
import { DecisionDto } from '@src/session/dto/session.response';
import { toDecisionDto } from '@src/session/session.service';
import { TimelineService } from '@src/timeline/timeline.service';

export interface NewDecision {
	content: string;
	createdById: string | null;
	approvalId?: string;
	conflictId?: string;
}

const withAuthor = {
	createdBy: { select: { id: true, firstname: true, lastname: true } },
} as const;

/**
 * The session's shared memory. The agent re-reads active decisions before
 * every section; people pin them by hand, and answering approvals with a note
 * or settling conflicts pins them automatically.
 */
@Injectable()
export class DecisionService {
	constructor(private readonly timeline: TimelineService) {}

	/** Pins a decision inside the caller's timeline transaction. */
	async pin(
		tx: Prisma.TransactionClient,
		sessionId: string,
		d: NewDecision,
	): Promise<DecisionDto> {
		const decision = await tx.decision.create({
			data: {
				sessionId,
				content: d.content,
				createdById: d.createdById,
				approvalId: d.approvalId ?? null,
				conflictId: d.conflictId ?? null,
			},
			include: withAuthor,
		});
		const dto = toDecisionDto(decision);
		await this.timeline.append(tx, sessionId, {
			type: EventType.DECISION_PINNED,
			actorType: d.createdById ? ActorType.USER : ActorType.AGENT,
			actorId: d.createdById,
			payload: {
				decisionId: decision.id,
				content: decision.content,
				origin: dto.origin,
				...(dto.createdBy ? { actor: dto.createdBy } : {}),
			},
		});
		return dto;
	}

	pinByHand(membership: SessionMember, content: string): Promise<DecisionDto> {
		return this.timeline.transaction((tx) =>
			this.pin(tx, membership.sessionId, {
				content,
				createdById: membership.userId,
			}),
		);
	}

	/** Unpins (keeps the row, sets unpinnedAt). The agent stops following it. */
	async unpin(membership: SessionMember, decisionId: string): Promise<void> {
		const { sessionId, userId } = membership;
		await this.timeline.transaction(async (tx) => {
			const { count } = await tx.decision.updateMany({
				where: { id: decisionId, sessionId, unpinnedAt: null },
				data: { unpinnedAt: new Date() },
			});
			if (count === 0) throw new NotFoundException('Decision not found');
			const decision = await tx.decision.findUniqueOrThrow({
				where: { id: decisionId },
			});
			await this.timeline.append(tx, sessionId, {
				type: EventType.DECISION_UNPINNED,
				actorType: ActorType.USER,
				actorId: userId,
				payload: {
					decisionId,
					content: decision.content,
					actor: await this.timeline.actorSnapshot(tx, userId),
				},
			});
		});
	}
}
