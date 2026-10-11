import { ActorType, EventType, SessionRole } from '@huddle/shared';
import {
	BadRequestException,
	Injectable,
	NotFoundException,
} from '@nestjs/common';
import { Prisma, SessionMember } from '@prisma/client';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { UpdateMemberDto } from './dto/member.request';
import { MemberDto } from './dto/session.response';

@Injectable()
export class MembersService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
	) {}

	/**
	 * Changes a member between Editor and Viewer, and/or switches "allowed to
	 * approve" for an Editor. Becoming a Viewer switches approval off. The Owner's
	 * own membership can't be changed here; that's what handoff is for.
	 */
	async update(
		owner: SessionMember,
		targetUserId: string,
		dto: UpdateMemberDto,
	): Promise<MemberDto> {
		return this.prisma.$transaction(async (tx) => {
			const target = await this.findTarget(tx, owner.sessionId, targetUserId);
			if (target.role === SessionRole.OWNER) {
				throw new BadRequestException(
					"The Owner's role changes only through a handoff",
				);
			}

			const role = (dto.role ?? target.role) as SessionRole;
			if (role === SessionRole.VIEWER && dto.canApprove === true) {
				throw new BadRequestException('Only Editors can be allowed to approve');
			}
			const canApprove =
				role === SessionRole.VIEWER
					? false
					: (dto.canApprove ?? target.canApprove);

			if (role === target.role && canApprove === target.canApprove) {
				return this.toMemberDto(tx, target);
			}

			const updated = await tx.sessionMember.update({
				where: { id: target.id },
				data: { role, canApprove },
			});
			await this.timeline.append(tx, owner.sessionId, {
				type: EventType.ROLE_CHANGED,
				actorType: ActorType.USER,
				actorId: owner.userId,
				payload: {
					actor: await this.timeline.actorSnapshot(tx, owner.userId),
					member: await this.timeline.actorSnapshot(tx, targetUserId),
					from: { role: target.role, canApprove: target.canApprove },
					to: { role, canApprove },
				},
			});
			return this.toMemberDto(tx, updated);
		});
	}

	/** Removes someone from the session. They lose access immediately. The Owner can't be removed. */
	async remove(owner: SessionMember, targetUserId: string): Promise<void> {
		await this.prisma.$transaction(async (tx) => {
			const target = await this.findTarget(tx, owner.sessionId, targetUserId);
			if (target.role === SessionRole.OWNER) {
				throw new BadRequestException(
					"The Owner can't be removed. Hand the session to someone else first.",
				);
			}
			// Snapshot the name before the membership goes.
			const member = await this.timeline.actorSnapshot(tx, targetUserId);
			await tx.sessionMember.delete({ where: { id: target.id } });
			await this.timeline.append(tx, owner.sessionId, {
				type: EventType.MEMBER_REMOVED,
				actorType: ActorType.USER,
				actorId: owner.userId,
				payload: {
					actor: await this.timeline.actorSnapshot(tx, owner.userId),
					member,
					role: target.role,
				},
			});
		});
	}

	private async findTarget(
		tx: Prisma.TransactionClient,
		sessionId: string,
		userId: string,
	): Promise<SessionMember> {
		const target = await tx.sessionMember.findUnique({
			where: { sessionId_userId: { sessionId, userId } },
		});
		if (!target)
			throw new NotFoundException('Member not found in this session');
		return target;
	}

	private async toMemberDto(
		tx: Prisma.TransactionClient,
		m: SessionMember,
	): Promise<MemberDto> {
		const user = await tx.user.findUniqueOrThrow({
			where: { id: m.userId },
			select: { username: true, firstname: true, lastname: true },
		});
		return {
			userId: m.userId,
			username: user.username,
			firstname: user.firstname,
			lastname: user.lastname,
			role: m.role as SessionRole,
			canApprove: m.canApprove,
			joinedAt: m.joinedAt.toISOString(),
		};
	}
}
