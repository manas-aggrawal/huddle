import {
	ActorType,
	AgentState,
	ApprovalKind,
	ApprovalStatus,
	BLOCKING_APPROVAL_KINDS,
	can,
	Effort,
	EventType,
	MessageMode,
	MessageStatus,
	SessionRole,
	SessionStatus,
	SocketEvent,
	StepStatus,
	WorkspaceRole,
} from '@huddle/shared';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
} from '@nestjs/common';
import {
	Decision,
	Handoff,
	Prisma,
	Session,
	SessionMember,
} from '@prisma/client';
import {
	DEFAULT_MODEL_ID,
	DEFAULT_MODEL_PROVIDER,
} from '@src/configs/env-vars';
import { isAllowedModel } from '@src/models/models.registry';
import { PrismaService } from '@src/prisma/prisma.service';
import { BroadcastService } from '@src/realtime/broadcast.service';
import { TimelineService } from '@src/timeline/timeline.service';
import {
	CreateSessionDto,
	ListSessionsQueryDto,
	StatusAction,
	UpdateSessionStatusDto,
	UpdateSettingsDto,
} from './dto/session.request';
import {
	DecisionDto,
	SessionDetailDto,
	SessionDto,
	SessionListItemDto,
} from './dto/session.response';

/** Which statuses each action can start from, for the status endpoint. */
const ALLOWED_FROM: Record<UpdateSessionStatusDto['action'], SessionStatus[]> =
	{
		pause: [
			SessionStatus.PLANNING,
			SessionStatus.RUNNING,
			SessionStatus.WAITING,
		],
		resume: [SessionStatus.PAUSED],
		end: [
			SessionStatus.PLANNING,
			SessionStatus.RUNNING,
			SessionStatus.WAITING,
			SessionStatus.PAUSED,
		],
	};

const ROLE_ORDER: Record<string, number> = {
	[SessionRole.OWNER]: 0,
	[SessionRole.EDITOR]: 1,
	[SessionRole.VIEWER]: 2,
};

/**
 * Display order for the member list: Owner, then Editors, then Viewers; within
 * a role, by join time, then username. Fully defined so ties (members added in
 * the same statement share a timestamp) never reorder between requests.
 */
function byRoleThenJoined(
	a: SessionMember & { user: { username: string } },
	b: SessionMember & { user: { username: string } },
): number {
	return (
		ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
		a.joinedAt.getTime() - b.joinedAt.getTime() ||
		a.user.username.localeCompare(b.user.username)
	);
}

export function toDecisionDto(
	d: Decision & {
		createdBy: { id: string; firstname: string; lastname: string } | null;
	},
): DecisionDto {
	return {
		id: d.id,
		content: d.content,
		origin: d.conflictId ? 'conflict' : d.approvalId ? 'approval' : 'manual',
		createdBy: d.createdBy
			? {
					id: d.createdBy.id,
					name: `${d.createdBy.firstname} ${d.createdBy.lastname}`.trim(),
				}
			: null,
		pinnedAt: d.pinnedAt.toISOString(),
	};
}

type Person = { id: string; firstname: string; lastname: string };
const person = (u: Person) => ({
	id: u.id,
	name: `${u.firstname} ${u.lastname}`.trim(),
});

function toHandoffDto(
	h: Handoff & { fromUser: Person; toUser: Person },
): NonNullable<SessionDetailDto['lastHandoff']> {
	return {
		id: h.id,
		from: person(h.fromUser),
		to: person(h.toUser),
		briefing: h.briefing,
		note: h.note,
		createdAt: h.createdAt.toISOString(),
	};
}

function toSessionDto(s: Session): SessionDto {
	return {
		id: s.id,
		workspaceId: s.workspaceId,
		title: s.title,
		goal: s.goal,
		status: s.status as SessionStatus,
		agentState: s.agentState as AgentState,
		modelProvider: s.modelProvider,
		modelId: s.modelId,
		effort: s.effort as Effort,
		tokenBudget: s.tokenBudget,
		tokensUsed: s.tokensUsed,
		lastEventSeq: s.lastEventSeq,
		createdAt: s.createdAt.toISOString(),
		updatedAt: s.updatedAt.toISOString(),
		completedAt: s.completedAt?.toISOString() ?? null,
	};
}

@Injectable()
export class SessionService {
	/** Run before a session is deleted, e.g. to stop its agent. */
	private readonly beforeDelete: ((sessionId: string) => Promise<void>)[] = [];

	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly broadcast: BroadcastService,
	) {}

	/** Registers work that must finish before a session is deleted. */
	onBeforeDelete(hook: (sessionId: string) => Promise<void>) {
		this.beforeDelete.push(hook);
	}

	/**
	 * Deletes the session and everything in it (doc, plan, messages, timeline,
	 * approvals, usage records, notifications). Owner only. The agent is stopped
	 * first so nothing writes to it mid-delete. Tokens already used still count
	 * against the workspace pool. Every member's open tabs are told it's gone.
	 */
	async delete(membership: SessionMember): Promise<void> {
		const sessionId = membership.sessionId;
		const members = await this.prisma.sessionMember.findMany({
			where: { sessionId },
			select: { userId: true },
		});
		for (const hook of this.beforeDelete) await hook(sessionId);
		await this.prisma.session.delete({ where: { id: sessionId } });
		for (const m of members) {
			this.broadcast.toUser(m.userId, SocketEvent.SESSION_REMOVED, {
				sessionId,
				reason: 'deleted',
			});
		}
	}

	/**
	 * Creates the session, makes the caller its Owner, and writes timeline event #1,
	 * all in one transaction. Optional context becomes the first message (a
	 * Suggest from the creator). Any member of the workspace can create a session.
	 */
	async create(userId: string, dto: CreateSessionDto): Promise<SessionDto> {
		const workspaceId = await this.resolveWorkspace(userId, dto.workspaceId);
		const modelProvider = dto.modelProvider ?? DEFAULT_MODEL_PROVIDER;
		const modelId = dto.modelId ?? DEFAULT_MODEL_ID;
		if (!isAllowedModel(modelProvider, modelId)) {
			throw new BadRequestException(
				`Model ${modelProvider}:${modelId} isn't available. GET /models lists the ones you can use.`,
			);
		}

		const session = await this.timeline.transaction(async (tx) => {
			const created = await tx.session.create({
				data: {
					workspaceId,
					title: dto.title,
					goal: dto.goal,
					modelProvider: dto.modelProvider ?? DEFAULT_MODEL_PROVIDER,
					modelId: dto.modelId ?? DEFAULT_MODEL_ID,
					effort: dto.effort ?? Effort.MEDIUM,
					tokenBudget: dto.tokenBudget ?? null,
					members: { create: { userId, role: SessionRole.OWNER } },
				},
			});
			const actor = await this.timeline.actorSnapshot(tx, userId);
			await this.timeline.append(tx, created.id, {
				type: EventType.SESSION_CREATED,
				actorType: ActorType.USER,
				actorId: userId,
				payload: { actor, title: created.title, goal: created.goal },
			});
			// Background the creator gave goes to the agent as their first Suggest.
			if (dto.context) {
				const message = await tx.message.create({
					data: {
						sessionId: created.id,
						authorId: userId,
						mode: MessageMode.SUGGEST,
						status: MessageStatus.QUEUED,
						content: dto.context,
					},
				});
				await this.timeline.append(tx, created.id, {
					type: EventType.HUMAN_MESSAGE,
					actorType: ActorType.USER,
					actorId: userId,
					payload: {
						actor,
						messageId: message.id,
						mode: message.mode,
						content: message.content,
						author: { ...actor, role: SessionRole.OWNER },
					},
				});
			}
			// The creator has seen everything so far (no catch-up card for them).
			const fresh = await tx.session.findUniqueOrThrow({
				where: { id: created.id },
			});
			await tx.sessionMember.updateMany({
				where: { sessionId: created.id, userId },
				data: { lastSeenSeq: fresh.lastEventSeq },
			});
			// Re-read so lastEventSeq/updatedAt reflect the event just written.
			return fresh;
		});

		return toSessionDto(session);
	}

	/** Sessions the caller is a member of, most recently active first. */
	async listMine(
		userId: string,
		query: ListSessionsQueryDto,
	): Promise<SessionListItemDto[]> {
		const memberships = await this.prisma.sessionMember.findMany({
			where: {
				userId,
				...(query.status ? { session: { status: query.status } } : {}),
			},
			include: {
				session: {
					include: {
						_count: { select: { members: true } },
						members: {
							include: {
								user: {
									select: { username: true, firstname: true, lastname: true },
								},
							},
						},
						approvals: {
							where: { status: ApprovalStatus.PENDING },
							select: { id: true },
						},
					},
				},
			},
			// sessionId breaks ties so the order is stable between requests.
			orderBy: [{ session: { updatedAt: 'desc' } }, { sessionId: 'asc' }],
		});
		const unread = await this.prisma.notification.groupBy({
			by: ['sessionId'],
			where: { userId, readAt: null },
			_count: { _all: true },
		});
		const unreadBy = new Map(unread.map((u) => [u.sessionId, u._count._all]));
		return memberships.map((m) => {
			const members = [...m.session.members].sort(byRoleThenJoined);
			const owner = members.find((x) => x.role === SessionRole.OWNER);
			const name = (x: (typeof members)[number]) =>
				`${x.user.firstname} ${x.user.lastname}`.trim();
			const unreadCount = unreadBy.get(m.sessionId) ?? 0;
			const canApprove = can(
				{ role: m.role as SessionRole, canApprove: m.canApprove },
				'approve',
			);
			const { members: _m, approvals, ...session } = m.session;
			return {
				...toSessionDto(session),
				myRole: m.role as SessionRole,
				memberCount: m.session._count.members,
				owner: owner ? { id: owner.userId, name: name(owner) } : null,
				memberPreview: members
					.slice(0, 5)
					.map((x) => ({ userId: x.userId, name: name(x) })),
				waitingOnMe: unreadCount > 0 || (canApprove && approvals.length > 0),
				unreadCount,
			};
		});
	}

	/** Everything the session room needs on first load. Access is checked by the guard. */
	async getDetail(membership: SessionMember): Promise<SessionDetailDto> {
		const session = await this.prisma.session.findUniqueOrThrow({
			where: { id: membership.sessionId },
			include: {
				members: {
					include: {
						user: {
							select: { username: true, firstname: true, lastname: true },
						},
					},
				},
				planSteps: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
				approvals: {
					where: { status: ApprovalStatus.PENDING },
					orderBy: { requestedAt: 'asc' },
				},
				conflicts: {
					where: { resolvedAt: null },
					orderBy: { createdAt: 'asc' },
				},
				workspace: {
					select: { tokenAllowance: true, tokensUsedThisPeriod: true },
				},
				handoffs: {
					orderBy: { createdAt: 'desc' },
					take: 1,
					include: {
						fromUser: { select: { id: true, firstname: true, lastname: true } },
						toUser: { select: { id: true, firstname: true, lastname: true } },
					},
				},
				decisions: {
					where: { unpinnedAt: null },
					orderBy: { pinnedAt: 'asc' },
					include: {
						createdBy: {
							select: { id: true, firstname: true, lastname: true },
						},
					},
				},
			},
		});

		return {
			...toSessionDto(session),
			myRole: membership.role as SessionRole,
			myCanApprove: membership.canApprove,
			members: [...session.members].sort(byRoleThenJoined).map((m) => ({
				userId: m.userId,
				username: m.user.username,
				firstname: m.user.firstname,
				lastname: m.user.lastname,
				role: m.role as SessionRole,
				canApprove: m.canApprove,
				joinedAt: m.joinedAt.toISOString(),
			})),
			planSteps: session.planSteps.map((p) => ({
				id: p.id,
				position: p.position,
				title: p.title,
				description: p.description,
				status: p.status as StepStatus,
				sectionId: p.sectionId,
				requiresApproval: p.requiresApproval,
			})),
			pendingApprovals: session.approvals.map((a) => ({
				id: a.id,
				kind: a.kind as ApprovalKind,
				title: a.title,
				details: a.details ?? null,
				planStepId: a.planStepId,
				requestedAt: a.requestedAt.toISOString(),
			})),
			decisions: session.decisions.map(toDecisionDto),
			openConflicts: session.conflicts.map((c) => ({
				id: c.id,
				summary: c.summary,
				planStepId: c.planStepId,
				createdAt: c.createdAt.toISOString(),
			})),
			workspaceUsage: session.workspace,
			lastHandoff: session.handoffs[0]
				? toHandoffDto(session.handoffs[0])
				: null,
		};
	}

	/**
	 * Pause, resume or end. Resuming returns the session to wherever its work
	 * stands: WAITING if an approval is pending, PLANNING if there's no plan
	 * yet, otherwise RUNNING. The update only applies if the status hasn't
	 * changed since we read it, so two Owners' clicks can't race.
	 */
	async changeStatus(
		membership: SessionMember,
		dto: UpdateSessionStatusDto,
	): Promise<SessionDto> {
		const sessionId = membership.sessionId;

		const session = await this.timeline.transaction(async (tx) => {
			const current = await tx.session.findUniqueOrThrow({
				where: { id: sessionId },
			});
			const from = current.status as SessionStatus;
			if (!ALLOWED_FROM[dto.action].includes(from)) {
				throw new ConflictException(
					`Can't ${dto.action} a session that is ${from.toLowerCase()}`,
				);
			}

			const to =
				dto.action === StatusAction.PAUSE
					? SessionStatus.PAUSED
					: dto.action === StatusAction.END
						? SessionStatus.DONE
						: await this.statusToResumeTo(tx, sessionId);

			const { count } = await tx.session.updateMany({
				where: { id: sessionId, status: from },
				data: {
					status: to,
					...(to === SessionStatus.DONE
						? { completedAt: new Date(), agentState: AgentState.IDLE }
						: {}),
				},
			});
			if (count === 0) {
				throw new ConflictException(
					'The session status changed while you were updating it. Reload and try again.',
				);
			}
			// Nothing is left to approve once the session has ended.
			if (to === SessionStatus.DONE) {
				await tx.approval.updateMany({
					where: { sessionId, status: ApprovalStatus.PENDING },
					data: { status: ApprovalStatus.CANCELLED, resolvedAt: new Date() },
				});
			}

			await this.timeline.append(tx, sessionId, {
				type: EventType.STATUS_CHANGED,
				actorType: ActorType.USER,
				actorId: membership.userId,
				payload: {
					actor: await this.timeline.actorSnapshot(tx, membership.userId),
					action: dto.action,
					from,
					to,
				},
			});
			return tx.session.findUniqueOrThrow({ where: { id: sessionId } });
		});

		return toSessionDto(session);
	}

	private async statusToResumeTo(
		tx: Prisma.TransactionClient,
		sessionId: string,
	): Promise<SessionStatus> {
		const [pendingApprovals, planSteps] = await Promise.all([
			tx.approval.count({
				where: {
					sessionId,
					status: ApprovalStatus.PENDING,
					kind: { in: [...BLOCKING_APPROVAL_KINDS] },
				},
			}),
			tx.planStep.count({ where: { sessionId } }),
		]);
		if (pendingApprovals > 0) return SessionStatus.WAITING;
		if (planSteps === 0) return SessionStatus.PLANNING;
		return SessionStatus.RUNNING;
	}

	/**
	 * Model, effort and the session's token cap. Owner only. Applies from the
	 * agent's next model call. Raising the cap past what's used clears a
	 * pending budget approval.
	 */
	async updateSettings(
		membership: SessionMember,
		dto: UpdateSettingsDto,
	): Promise<SessionDto> {
		const sessionId = membership.sessionId;
		if (
			dto.modelProvider !== undefined &&
			dto.modelId !== undefined &&
			!isAllowedModel(dto.modelProvider, dto.modelId)
		) {
			throw new BadRequestException(
				`Model ${dto.modelProvider}:${dto.modelId} isn't available. GET /models lists the ones you can use.`,
			);
		}
		const session = await this.timeline.transaction(async (tx) => {
			const before = await tx.session.findUniqueOrThrow({
				where: { id: sessionId },
			});
			if (before.status === SessionStatus.DONE) {
				throw new ConflictException('This session is done');
			}
			const updated = await tx.session.update({
				where: { id: sessionId },
				data: {
					...(dto.modelProvider !== undefined
						? { modelProvider: dto.modelProvider, modelId: dto.modelId }
						: {}),
					...(dto.effort !== undefined ? { effort: dto.effort } : {}),
					...(dto.tokenBudget !== undefined
						? { tokenBudget: dto.tokenBudget }
						: {}),
				},
			});
			const capCleared =
				updated.tokenBudget === null ||
				updated.tokenBudget > updated.tokensUsed;
			if (dto.tokenBudget !== undefined && capCleared) {
				await this.clearBudgetGate(tx, sessionId);
			}
			await this.timeline.append(tx, sessionId, {
				type: EventType.MODEL_CHANGED,
				actorType: ActorType.USER,
				actorId: membership.userId,
				payload: {
					actor: await this.timeline.actorSnapshot(tx, membership.userId),
					modelProvider: updated.modelProvider,
					modelId: updated.modelId,
					effort: updated.effort,
					tokenBudget: updated.tokenBudget,
					from: {
						modelProvider: before.modelProvider,
						modelId: before.modelId,
						effort: before.effort,
						tokenBudget: before.tokenBudget,
					},
				},
			});
			return tx.session.findUniqueOrThrow({ where: { id: sessionId } });
		});
		return toSessionDto(session);
	}

	/** A pending budget approval is moot once the cap is raised: cancel it and carry on. */
	private async clearBudgetGate(
		tx: Prisma.TransactionClient,
		sessionId: string,
	) {
		const { count } = await tx.approval.updateMany({
			where: {
				sessionId,
				kind: ApprovalKind.BUDGET,
				status: ApprovalStatus.PENDING,
			},
			data: { status: ApprovalStatus.CANCELLED, resolvedAt: new Date() },
		});
		if (count === 0) return;
		const to = await this.statusToResumeTo(tx, sessionId);
		await tx.session.updateMany({
			where: { id: sessionId, status: SessionStatus.WAITING },
			data: { status: to },
		});
	}

	/**
	 * Pauses a session for a system reason (the workspace pool ran out), with a
	 * STATUS_CHANGED by Huddle and a BUDGET_WARNING saying why.
	 */
	async pauseBySystem(
		sessionId: string,
		reason: string,
		details: Record<string, number>,
	) {
		await this.timeline.transaction(async (tx) => {
			const current = await tx.session.findUniqueOrThrow({
				where: { id: sessionId },
			});
			const from = current.status as SessionStatus;
			if (!ALLOWED_FROM.pause.includes(from)) return;
			await tx.session.update({
				where: { id: sessionId },
				data: { status: SessionStatus.PAUSED, agentState: AgentState.IDLE },
			});
			await this.timeline.append(tx, sessionId, {
				type: EventType.STATUS_CHANGED,
				actorType: ActorType.SYSTEM,
				payload: { action: 'pause', from, to: SessionStatus.PAUSED, reason },
			});
			await this.timeline.append(tx, sessionId, {
				type: EventType.BUDGET_WARNING,
				actorType: ActorType.SYSTEM,
				payload: { reason, ...details },
			});
		});
	}

	/** Undoes pauseBySystem when its reason is gone (only for sessions it paused). */
	async resumeBySystem(sessionId: string, reason: string) {
		await this.timeline.transaction(async (tx) => {
			const current = await tx.session.findUniqueOrThrow({
				where: { id: sessionId },
			});
			if (current.status !== SessionStatus.PAUSED) return;
			const lastStatus = await tx.timelineEvent.findFirst({
				where: { sessionId, type: EventType.STATUS_CHANGED },
				orderBy: { seq: 'desc' },
			});
			if (
				(lastStatus?.payload as { reason?: string } | null)?.reason !== reason
			)
				return;
			const to = await this.statusToResumeTo(tx, sessionId);
			await tx.session.update({
				where: { id: sessionId },
				data: { status: to },
			});
			await this.timeline.append(tx, sessionId, {
				type: EventType.STATUS_CHANGED,
				actorType: ActorType.SYSTEM,
				payload: { action: 'resume', from: SessionStatus.PAUSED, to, reason },
			});
		});
	}

	/** The workspace to create in: the one given (if the caller belongs to it), else their personal one. */
	private async resolveWorkspace(
		userId: string,
		workspaceId?: string,
	): Promise<string> {
		if (workspaceId) {
			const member = await this.prisma.workspaceMember.findUnique({
				where: { workspaceId_userId: { workspaceId, userId } },
			});
			if (!member) {
				throw new ForbiddenException("You're not a member of this workspace");
			}
			return workspaceId;
		}

		const personal = await this.prisma.workspaceMember.findFirst({
			where: { userId, role: WorkspaceRole.ADMIN },
			orderBy: { joinedAt: 'asc' },
		});
		if (!personal) {
			throw new BadRequestException(
				'You have no workspace yet. Pass a workspaceId you belong to.',
			);
		}
		return personal.workspaceId;
	}
}
