import {
	ActorType,
	AgentState,
	ApprovalKind,
	ApprovalStatus,
	Effort,
	EventType,
	SessionRole,
	SessionStatus,
	StepStatus,
	WorkspaceRole,
} from '@huddle/shared';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
} from '@nestjs/common';
import { Prisma, Session, SessionMember } from '@prisma/client';
import {
	DEFAULT_MODEL_ID,
	DEFAULT_MODEL_PROVIDER,
} from '@src/configs/env-vars';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import {
	CreateSessionDto,
	ListSessionsQueryDto,
	StatusAction,
	UpdateSessionStatusDto,
} from './dto/session.request';
import {
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
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
	) {}

	/**
	 * Creates the session, makes the caller its Owner, and writes timeline event #1,
	 * all in one transaction. Any member of the workspace can create a session.
	 */
	async create(userId: string, dto: CreateSessionDto): Promise<SessionDto> {
		const workspaceId = await this.resolveWorkspace(userId, dto.workspaceId);

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
			await this.timeline.append(tx, created.id, {
				type: EventType.SESSION_CREATED,
				actorType: ActorType.USER,
				actorId: userId,
				payload: {
					actor: await this.timeline.actorSnapshot(tx, userId),
					title: created.title,
					goal: created.goal,
				},
			});
			// Re-read so lastEventSeq/updatedAt reflect the event just written.
			return tx.session.findUniqueOrThrow({ where: { id: created.id } });
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
				session: { include: { _count: { select: { members: true } } } },
			},
			// sessionId breaks ties so the order is stable between requests.
			orderBy: [{ session: { updatedAt: 'desc' } }, { sessionId: 'asc' }],
		});
		return memberships.map((m) => ({
			...toSessionDto(m.session),
			myRole: m.role as SessionRole,
			memberCount: m.session._count.members,
		}));
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
				where: { sessionId, status: ApprovalStatus.PENDING },
			}),
			tx.planStep.count({ where: { sessionId } }),
		]);
		if (pendingApprovals > 0) return SessionStatus.WAITING;
		if (planSteps === 0) return SessionStatus.PLANNING;
		return SessionStatus.RUNNING;
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
