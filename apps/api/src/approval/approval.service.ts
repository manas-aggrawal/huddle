import {
	ActorType,
	AgentState,
	ApprovalKind,
	ApprovalStatus,
	BLOCKING_APPROVAL_KINDS,
	EventType,
	NotificationType,
	SessionRole,
	SessionStatus,
	StepStatus,
} from '@huddle/shared';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { Approval, Prisma, SessionMember } from '@prisma/client';
import { DecisionService } from '@src/decision/decision.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { ApprovalDecision, ResolveApprovalDto } from './dto/approval.dto';

export interface ApprovalRequest {
	kind: ApprovalKind;
	title: string;
	details?: Prisma.InputJsonValue;
	planStepId?: string | null;
}

/** What a resolved approval did, for whoever reacts to it (the agent runner). */
export interface ApprovalPayload {
	approvalId: string;
	kind: ApprovalKind;
	title: string;
	planStepId: string | null;
	status?: ApprovalStatus;
	note?: string | null;
}

/**
 * Approval gates: the agent asks, an approver answers. A pending approval
 * always puts the session in WAITING, and answering the last one moves it on,
 * in the same transaction as the approval itself, so the two never disagree.
 */
@Injectable()
export class ApprovalService {
	constructor(
		private readonly timeline: TimelineService,
		private readonly decisions: DecisionService,
	) {}

	/**
	 * Creates a pending approval inside the caller's timeline transaction, sets
	 * the session to WAITING (unless it's paused) and tells everyone who can
	 * approve.
	 */
	async request(
		tx: Prisma.TransactionClient,
		sessionId: string,
		req: ApprovalRequest,
	): Promise<Approval> {
		const approval = await tx.approval.create({
			data: {
				sessionId,
				kind: req.kind,
				title: req.title,
				details: req.details ?? Prisma.JsonNull,
				planStepId: req.planStepId ?? null,
			},
		});
		if (BLOCKING_APPROVAL_KINDS.includes(req.kind)) {
			await tx.session.updateMany({
				where: {
					id: sessionId,
					status: { in: [SessionStatus.PLANNING, SessionStatus.RUNNING] },
				},
				data: { status: SessionStatus.WAITING, agentState: AgentState.IDLE },
			});
		}

		const approvers = await tx.sessionMember.findMany({
			where: {
				sessionId,
				OR: [
					{ role: SessionRole.OWNER },
					{ role: SessionRole.EDITOR, canApprove: true },
				],
			},
			select: { userId: true },
		});
		await tx.notification.createMany({
			data: approvers.map((a) => ({
				userId: a.userId,
				sessionId,
				type: NotificationType.APPROVAL_REQUESTED,
				title: `Approval needed: ${req.title}`.slice(0, 200),
				refId: approval.id,
			})),
		});

		const payload: ApprovalPayload = {
			approvalId: approval.id,
			kind: req.kind,
			title: req.title,
			planStepId: approval.planStepId,
		};
		await this.timeline.append(tx, sessionId, {
			type: EventType.APPROVAL_REQUESTED,
			actorType: ActorType.AGENT,
			payload: { ...payload, details: req.details ?? null },
		});
		return approval;
	}

	/**
	 * Approve or reject. The first answer wins; a second one gets 409. Answering
	 * the last pending approval moves the session on: back to RUNNING, to
	 * PLANNING for a rejected outline, or to DONE for an approved final draft.
	 */
	async resolve(
		membership: SessionMember,
		approvalId: string,
		dto: ResolveApprovalDto,
	): Promise<Approval> {
		const { sessionId, userId } = membership;
		const approved = dto.decision === ApprovalDecision.APPROVE;

		return this.timeline.transaction(async (tx) => {
			const approval = await tx.approval.findFirst({
				where: { id: approvalId, sessionId },
			});
			if (!approval) throw new NotFoundException('Approval not found');
			if (!approved && approval.kind === ApprovalKind.MARK_FINAL && !dto.note) {
				throw new BadRequestException(
					'Say what still needs work: rejecting the final draft needs a note',
				);
			}

			const status = approved
				? ApprovalStatus.APPROVED
				: ApprovalStatus.REJECTED;
			// Conditional, so of two approvers answering at once only one wins.
			const { count } = await tx.approval.updateMany({
				where: { id: approvalId, status: ApprovalStatus.PENDING },
				data: {
					status,
					resolvedById: userId,
					resolvedAt: new Date(),
					note: dto.note ?? null,
				},
			});
			if (count === 0) {
				throw new ConflictException(
					'This approval was already answered. Reload to see the outcome.',
				);
			}

			await this.moveSessionOn(tx, sessionId, approval, approved);

			const actor = await this.timeline.actorSnapshot(tx, userId);
			const payload: ApprovalPayload = {
				approvalId,
				kind: approval.kind as ApprovalKind,
				title: approval.title,
				planStepId: approval.planStepId,
				status,
				note: dto.note ?? null,
			};
			await this.timeline.append(tx, sessionId, {
				type: EventType.APPROVAL_RESOLVED,
				actorType: ActorType.USER,
				actorId: userId,
				payload: { ...payload, actor, resolvedBy: actor },
			});
			// A note on an answer is something the team decided: pin it.
			if (dto.note) {
				await this.decisions.pin(tx, sessionId, {
					content: `On “${approval.title}”: ${dto.note}`,
					createdById: userId,
					approvalId,
				});
			}
			return tx.approval.findUniqueOrThrow({ where: { id: approvalId } });
		});
	}

	/** Cancels every pending approval, e.g. when the session ends. */
	async cancelPending(tx: Prisma.TransactionClient, sessionId: string) {
		await tx.approval.updateMany({
			where: { sessionId, status: ApprovalStatus.PENDING },
			data: { status: ApprovalStatus.CANCELLED, resolvedAt: new Date() },
		});
	}

	private async moveSessionOn(
		tx: Prisma.TransactionClient,
		sessionId: string,
		approval: Approval,
		approved: boolean,
	) {
		const session = await tx.session.findUniqueOrThrow({
			where: { id: sessionId },
			select: { status: true },
		});
		if (session.status === SessionStatus.DONE) {
			throw new ConflictException('This session has ended');
		}
		const kind = approval.kind as ApprovalKind;
		// An approved budget gate raises the session's cap by what it asked for.
		if (kind === ApprovalKind.BUDGET && approved) {
			const extra =
				Number(
					(approval.details as { extraTokens?: number } | null)?.extraTokens,
				) || 0;
			const current = await tx.session.findUniqueOrThrow({
				where: { id: sessionId },
				select: { tokenBudget: true, tokensUsed: true },
			});
			if (current.tokenBudget !== null) {
				await tx.session.update({
					where: { id: sessionId },
					data: {
						tokenBudget:
							Math.max(current.tokenBudget, current.tokensUsed) + extra,
					},
				});
			}
		}
		// A rejected step gate drops that step; the rest of the plan goes on.
		if (kind === ApprovalKind.CUSTOM && !approved && approval.planStepId) {
			await tx.planStep.updateMany({
				where: { id: approval.planStepId, status: { not: StepStatus.DONE } },
				data: { status: StepStatus.SKIPPED },
			});
		}

		const stillBlocked = await tx.approval.count({
			where: {
				sessionId,
				status: ApprovalStatus.PENDING,
				kind: { in: [...BLOCKING_APPROVAL_KINDS] },
			},
		});
		// A paused session stays paused; resuming picks up from here.
		if (session.status !== SessionStatus.WAITING || stillBlocked > 0) return;

		if (kind === ApprovalKind.OUTLINE && !approved) {
			await tx.session.update({
				where: { id: sessionId },
				data: { status: SessionStatus.PLANNING },
			});
		} else if (kind === ApprovalKind.MARK_FINAL && approved) {
			await tx.session.update({
				where: { id: sessionId },
				data: {
					status: SessionStatus.DONE,
					completedAt: new Date(),
					agentState: AgentState.IDLE,
				},
			});
		} else {
			await tx.session.update({
				where: { id: sessionId },
				data: { status: SessionStatus.RUNNING },
			});
		}
	}
}
