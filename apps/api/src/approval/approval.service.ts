import {
	ActorType,
	AgentState,
	ApprovalKind,
	ApprovalStatus,
	EventType,
	NotificationType,
	SessionRole,
	SessionStatus,
} from '@huddle/shared';
import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { Approval, Prisma, SessionMember } from '@prisma/client';
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
	constructor(private readonly timeline: TimelineService) {}

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
		await tx.session.updateMany({
			where: {
				id: sessionId,
				status: { in: [SessionStatus.PLANNING, SessionStatus.RUNNING] },
			},
			data: { status: SessionStatus.WAITING, agentState: AgentState.IDLE },
		});

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
		const stillPending = await tx.approval.count({
			where: { sessionId, status: ApprovalStatus.PENDING },
		});
		// A paused session stays paused; resuming picks up from here.
		if (session.status !== SessionStatus.WAITING || stillPending > 0) return;

		const kind = approval.kind as ApprovalKind;
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
