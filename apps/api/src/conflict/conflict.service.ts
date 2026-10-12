import {
	ActorType,
	EventType,
	MessageStatus,
	NotificationType,
	SessionRole,
	StepStatus,
} from '@huddle/shared';
import {
	ConflictException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { Conflict, Prisma, SessionMember } from '@prisma/client';
import { DecisionService } from '@src/decision/decision.service';
import { TimelineService } from '@src/timeline/timeline.service';

export interface RaiseConflict {
	summary: string;
	messageIds: string[];
	planStepId?: string | null;
}

/**
 * Contradicting instructions. The agent doesn't pick a side: it records the
 * conflict, tags both authors, blocks only the affected step and carries on.
 * The Owner settles it, and the resolution becomes a pinned decision.
 */
@Injectable()
export class ConflictService {
	constructor(
		private readonly timeline: TimelineService,
		private readonly decisions: DecisionService,
	) {}

	/** Records a conflict inside the caller's timeline transaction. */
	async raise(
		tx: Prisma.TransactionClient,
		sessionId: string,
		c: RaiseConflict,
	): Promise<Conflict | null> {
		const messages = await tx.message.findMany({
			where: { sessionId, id: { in: c.messageIds } },
			include: {
				author: { select: { id: true, firstname: true, lastname: true } },
			},
		});
		if (messages.length < 2) return null; // Not a conflict between people's inputs.

		const step = c.planStepId
			? await tx.planStep.findFirst({ where: { id: c.planStepId, sessionId } })
			: null;
		const conflict = await tx.conflict.create({
			data: {
				sessionId,
				summary: c.summary,
				planStepId: step?.id ?? null,
				messages: { connect: messages.map((m) => ({ id: m.id })) },
			},
		});
		if (
			step &&
			(step.status === StepStatus.PENDING || step.status === StepStatus.BLOCKED)
		) {
			await tx.planStep.update({
				where: { id: step.id },
				data: { status: StepStatus.BLOCKED },
			});
		}

		const sides = messages.map((m) => ({
			messageId: m.id,
			content: m.content,
			author: {
				id: m.author.id,
				name: `${m.author.firstname} ${m.author.lastname}`.trim(),
			},
		}));
		await this.timeline.append(tx, sessionId, {
			type: EventType.CONFLICT_RAISED,
			actorType: ActorType.AGENT,
			payload: {
				conflictId: conflict.id,
				summary: c.summary,
				planStepId: step?.id ?? null,
				stepTitle: step?.title ?? null,
				sides,
			},
		});

		const owner = await tx.sessionMember.findFirst({
			where: { sessionId, role: SessionRole.OWNER },
			select: { userId: true },
		});
		const notify = new Set([
			...sides.map((s) => s.author.id),
			...(owner ? [owner.userId] : []),
		]);
		await tx.notification.createMany({
			data: [...notify].map((userId) => ({
				userId,
				sessionId,
				type: NotificationType.CONFLICT_RAISED,
				title: `Conflict: ${c.summary}`.slice(0, 200),
				refId: conflict.id,
			})),
		});
		return conflict;
	}

	/** Owner only (checked by the route). The first resolution wins; later ones get 409. */
	async resolve(
		membership: SessionMember,
		conflictId: string,
		resolution: string,
	): Promise<Conflict> {
		const { sessionId, userId } = membership;
		return this.timeline.transaction(async (tx) => {
			const conflict = await tx.conflict.findFirst({
				where: { id: conflictId, sessionId },
			});
			if (!conflict) throw new NotFoundException('Conflict not found');
			const { count } = await tx.conflict.updateMany({
				where: { id: conflictId, resolvedAt: null },
				data: { resolution, resolvedById: userId, resolvedAt: new Date() },
			});
			if (count === 0) {
				throw new ConflictException('This conflict was already resolved');
			}
			if (conflict.planStepId) {
				// Unblock unless another open conflict still holds the step.
				const others = await tx.conflict.count({
					where: { planStepId: conflict.planStepId, resolvedAt: null },
				});
				if (others === 0) {
					await tx.planStep.updateMany({
						where: { id: conflict.planStepId, status: StepStatus.BLOCKED },
						data: { status: StepStatus.PENDING },
					});
				}
			}
			// The inputs it settled are handled now.
			await tx.message.updateMany({
				where: {
					conflicts: { some: { id: conflictId } },
					status: { in: [MessageStatus.QUEUED, MessageStatus.ACKNOWLEDGED] },
				},
				data: { status: MessageStatus.APPLIED, processedAt: new Date() },
			});

			const actor = await this.timeline.actorSnapshot(tx, userId);
			await this.timeline.append(tx, sessionId, {
				type: EventType.CONFLICT_RESOLVED,
				actorType: ActorType.USER,
				actorId: userId,
				payload: {
					conflictId,
					summary: conflict.summary,
					resolution,
					planStepId: conflict.planStepId,
					actor,
				},
			});
			await this.decisions.pin(tx, sessionId, {
				content: resolution,
				createdById: userId,
				conflictId,
			});
			return tx.conflict.findUniqueOrThrow({ where: { id: conflictId } });
		});
	}
}
