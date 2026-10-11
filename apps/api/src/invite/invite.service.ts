import { createHash, randomBytes } from 'node:crypto';
import { ActorType, EventType, SessionRole } from '@huddle/shared';
import { GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { Invite, Prisma, SessionMember } from '@prisma/client';
import { WEB_APP_URL } from '@src/configs/env-vars';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { CreateInviteDto } from './dto/invite.request';
import {
	AcceptInviteDto,
	CreatedInviteDto,
	InviteDto,
	InvitePreviewDto,
} from './dto/invite.response';

/** Higher number = more power. Accepting a link can raise a role, never lower it. */
const ROLE_RANK: Record<SessionRole, number> = {
	VIEWER: 0,
	EDITOR: 1,
	OWNER: 2,
};

/** Links are stored as a sha256 fingerprint, so a database leak exposes no usable links. */
export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

type InviteWithCreator = Invite & {
	createdBy: { id: string; firstname: string; lastname: string };
};

const withCreator = {
	createdBy: { select: { id: true, firstname: true, lastname: true } },
} as const;

function fullName(u: { firstname: string; lastname: string }) {
	return `${u.firstname} ${u.lastname}`.trim();
}

function toInviteDto(i: InviteWithCreator): InviteDto {
	return {
		id: i.id,
		role: i.role as SessionRole,
		createdBy: { id: i.createdBy.id, name: fullName(i.createdBy) },
		useCount: i.useCount,
		expiresAt: i.expiresAt?.toISOString() ?? null,
		createdAt: i.createdAt.toISOString(),
	};
}

function isUsable(i: Invite): boolean {
	return !i.revokedAt && (!i.expiresAt || i.expiresAt > new Date());
}

@Injectable()
export class InviteService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
	) {}

	/** Creates a link. The raw token is returned once and never stored. */
	async create(
		membership: SessionMember,
		dto: CreateInviteDto,
	): Promise<CreatedInviteDto> {
		const token = randomBytes(32).toString('base64url');
		const invite = await this.prisma.invite.create({
			data: {
				sessionId: membership.sessionId,
				token: hashToken(token),
				role: dto.role,
				createdById: membership.userId,
				expiresAt: dto.expiresInHours
					? new Date(Date.now() + dto.expiresInHours * 3_600_000)
					: null,
			},
			include: withCreator,
		});
		return {
			...toInviteDto(invite),
			token,
			url: `${WEB_APP_URL.replace(/\/$/, '')}/invite/${token}`,
		};
	}

	/** Links that still work: not revoked and not expired, newest first. */
	async listActive(sessionId: string): Promise<InviteDto[]> {
		const invites = await this.prisma.invite.findMany({
			where: {
				sessionId,
				revokedAt: null,
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			include: withCreator,
			orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
		});
		return invites.map(toInviteDto);
	}

	/** Stops a link from working. Revoking twice is harmless. */
	async revoke(sessionId: string, inviteId: string): Promise<void> {
		const invite = await this.prisma.invite.findFirst({
			where: { id: inviteId, sessionId },
		});
		if (!invite) throw new NotFoundException('Invite not found');
		if (!invite.revokedAt) {
			await this.prisma.invite.update({
				where: { id: invite.id },
				data: { revokedAt: new Date() },
			});
		}
	}

	/** What someone sees before accepting. Works without logging in. */
	async preview(token: string): Promise<InvitePreviewDto> {
		const invite = await this.findUsable(this.prisma, token);
		const [session, creator] = await Promise.all([
			this.prisma.session.findUniqueOrThrow({
				where: { id: invite.sessionId },
				select: { title: true },
			}),
			this.prisma.user.findUniqueOrThrow({
				where: { id: invite.createdById },
				select: { firstname: true, lastname: true },
			}),
		]);
		return {
			sessionId: invite.sessionId,
			sessionTitle: session.title,
			invitedBy: fullName(creator),
			role: invite.role as SessionRole,
			expiresAt: invite.expiresAt?.toISOString() ?? null,
		};
	}

	/**
	 * Joins the session with the link's role. If the caller is already a member,
	 * a better link raises their role (Viewer → Editor); it never lowers it, and
	 * the Owner is never changed. Using a link that changes nothing is a no-op.
	 */
	async accept(userId: string, token: string): Promise<AcceptInviteDto> {
		try {
			return await this.timeline.transaction((tx) =>
				this.acceptInTx(tx, userId, token),
			);
		} catch (error) {
			// Two accepts from the same user at once: the second hits the unique
			// (sessionId, userId) index. The first one already did the work.
			if (
				error instanceof Prisma.PrismaClientKnownRequestError &&
				error.code === 'P2002'
			) {
				const invite = await this.findUsable(this.prisma, token);
				const member = await this.prisma.sessionMember.findUniqueOrThrow({
					where: { sessionId_userId: { sessionId: invite.sessionId, userId } },
				});
				return {
					sessionId: invite.sessionId,
					role: member.role as SessionRole,
					joined: false,
					upgraded: false,
				};
			}
			throw error;
		}
	}

	private async acceptInTx(
		tx: Prisma.TransactionClient,
		userId: string,
		token: string,
	): Promise<AcceptInviteDto> {
		const invite = await this.findUsable(tx, token);
		const { sessionId } = invite;
		const linkRole = invite.role as SessionRole;
		const existing = await tx.sessionMember.findUnique({
			where: { sessionId_userId: { sessionId, userId } },
		});

		if (!existing) {
			await tx.sessionMember.create({
				data: { sessionId, userId, role: linkRole },
			});
			await this.countUse(tx, invite.id);
			await this.timeline.append(tx, sessionId, {
				type: EventType.MEMBER_JOINED,
				actorType: ActorType.USER,
				actorId: userId,
				payload: {
					actor: await this.timeline.actorSnapshot(tx, userId),
					role: linkRole,
					via: 'invite',
					inviteId: invite.id,
				},
			});
			return { sessionId, role: linkRole, joined: true, upgraded: false };
		}

		const current = existing.role as SessionRole;
		if (ROLE_RANK[linkRole] <= ROLE_RANK[current]) {
			return { sessionId, role: current, joined: false, upgraded: false };
		}

		await tx.sessionMember.update({
			where: { id: existing.id },
			data: { role: linkRole },
		});
		await this.countUse(tx, invite.id);
		const who = await this.timeline.actorSnapshot(tx, userId);
		await this.timeline.append(tx, sessionId, {
			type: EventType.ROLE_CHANGED,
			actorType: ActorType.USER,
			actorId: userId,
			payload: {
				actor: who,
				member: who,
				from: { role: current, canApprove: existing.canApprove },
				to: { role: linkRole, canApprove: existing.canApprove },
				via: 'invite',
				inviteId: invite.id,
			},
		});
		return { sessionId, role: linkRole, joined: false, upgraded: true };
	}

	private countUse(tx: Prisma.TransactionClient, inviteId: string) {
		return tx.invite.update({
			where: { id: inviteId },
			data: { useCount: { increment: 1 } },
		});
	}

	/** 404 for a token that never existed; 410 for one that was revoked or has expired. */
	private async findUsable(
		db: Prisma.TransactionClient,
		token: string,
	): Promise<Invite> {
		const invite = await db.invite.findUnique({
			where: { token: hashToken(token) },
		});
		if (!invite) throw new NotFoundException('Invite link not found');
		if (!isUsable(invite)) {
			throw new GoneException(
				invite.revokedAt
					? 'This link was revoked. Ask the session Owner for a new one.'
					: 'This link has expired. Ask the session Owner for a new one.',
			);
		}
		return invite;
	}
}
