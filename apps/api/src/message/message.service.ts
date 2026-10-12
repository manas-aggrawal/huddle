import {
	ActorType,
	can,
	EventType,
	MessageMode,
	MessageStatus,
	mentionedUserIds,
	NotificationType,
	type SessionAction,
	SessionRole,
	SessionStatus,
} from '@huddle/shared';
import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
} from '@nestjs/common';
import { Message, Prisma, SessionMember } from '@prisma/client';
import { PrismaService } from '@src/prisma/prisma.service';
import { NotificationService } from '@src/realtime/notification.service';
import { TimelineService } from '@src/timeline/timeline.service';
import {
	CreateMessageDto,
	MessageDto,
	MessageWithAuthorDto,
} from './dto/message.dto';

/** Which permission each kind of message needs. */
const ACTION_FOR: Record<MessageMode, SessionAction> = {
	[MessageMode.SUGGEST]: 'suggest',
	[MessageMode.INTERRUPT]: 'interrupt',
	[MessageMode.ASK]: 'ask',
	[MessageMode.COMMENT]: 'comment',
};

export function toMessageDto(m: Message): MessageDto {
	return {
		id: m.id,
		sessionId: m.sessionId,
		authorId: m.authorId,
		mode: m.mode as MessageMode,
		content: m.content,
		anchor: m.anchor ?? null,
		planStepId: m.planStepId,
		status: m.status as MessageStatus,
		response: m.response,
		createdAt: m.createdAt.toISOString(),
	};
}

/** People's input to the agent: saved as a Message and announced on the timeline. */
@Injectable()
export class MessageService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly notifications: NotificationService,
	) {}

	async create(
		membership: SessionMember,
		dto: CreateMessageDto,
	): Promise<Message> {
		const { sessionId, userId } = membership;
		const role = membership.role as SessionRole;
		const action = ACTION_FOR[dto.mode];
		if (!can({ role, canApprove: membership.canApprove }, action)) {
			throw new ForbiddenException(
				`As ${role.toLowerCase()} of this session, you can't ${action}`,
			);
		}
		if (dto.mode === MessageMode.COMMENT && !dto.anchor) {
			throw new BadRequestException('A comment needs the text it refers to');
		}

		return this.timeline.transaction(async (tx) => {
			const session = await tx.session.findUniqueOrThrow({
				where: { id: sessionId },
				select: { status: true },
			});
			// A finished doc takes no more instructions, but questions still get answers.
			if (
				session.status === SessionStatus.DONE &&
				dto.mode !== MessageMode.ASK
			) {
				throw new ConflictException(
					'This session is done. You can still ask the agent questions.',
				);
			}
			if (dto.planStepId) {
				const step = await tx.planStep.count({
					where: { id: dto.planStepId, sessionId },
				});
				if (!step)
					throw new BadRequestException(
						'That plan step is not in this session',
					);
			}

			const message = await tx.message.create({
				data: {
					sessionId,
					authorId: userId,
					mode: dto.mode,
					status: MessageStatus.QUEUED,
					content: dto.content,
					planStepId: dto.planStepId ?? null,
					anchor: dto.anchor ?? Prisma.JsonNull,
				},
			});
			const actor = await this.timeline.actorSnapshot(tx, userId);
			await this.timeline.append(tx, sessionId, {
				type: EventType.HUMAN_MESSAGE,
				actorType: ActorType.USER,
				actorId: userId,
				payload: {
					actor,
					messageId: message.id,
					mode: message.mode,
					content: message.content,
					author: { ...actor, role },
					planStepId: message.planStepId,
					anchor: dto.anchor ?? null,
				},
			});
			await this.notifyMentions(tx, sessionId, userId, actor.name, message);
			return message;
		});
	}

	/** Messages in the session, oldest first (e.g. the doc's comments). */
	async list(
		sessionId: string,
		mode?: MessageMode,
	): Promise<MessageWithAuthorDto[]> {
		const rows = await this.prisma.message.findMany({
			where: { sessionId, ...(mode ? { mode } : {}) },
			orderBy: { createdAt: 'asc' },
			take: 500,
			include: {
				author: { select: { id: true, firstname: true, lastname: true } },
			},
		});
		return rows.map((m) => ({
			...toMessageDto(m),
			author: {
				id: m.author.id,
				name: `${m.author.firstname} ${m.author.lastname}`.trim(),
			},
		}));
	}

	/** A MENTION notification for each member named with @[userId] (not the author). */
	private async notifyMentions(
		tx: Prisma.TransactionClient,
		sessionId: string,
		authorId: string,
		authorName: string,
		message: Message,
	) {
		const ids = mentionedUserIds(message.content).filter(
			(id) => id !== authorId,
		);
		if (ids.length === 0) return;
		const members = await tx.sessionMember.findMany({
			where: { sessionId, userId: { in: ids } },
			select: { userId: true },
		});
		await this.notifications.create(
			tx,
			members.map((m) => ({
				userId: m.userId,
				sessionId,
				type: NotificationType.MENTION,
				title: `${authorName} mentioned you`,
				refId: message.id,
			})),
		);
	}
}
