import { MessageMode, MessageStatus } from '@huddle/shared';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@src/prisma/prisma.service';
import type { TeamInput } from './prompts';

export interface QueuedInput extends TeamInput {
	messageId: string;
	authorId: string;
	mode: MessageMode;
	anchor: unknown;
	planStepId: string | null;
}

/** Reads what the agent needs to know about a session for its prompts. */
@Injectable()
export class AgentContextService {
	constructor(private readonly prisma: PrismaService) {}

	/** Pinned decisions still in force, oldest first. */
	async activeDecisions(sessionId: string): Promise<string[]> {
		const rows = await this.prisma.decision.findMany({
			where: { sessionId, unpinnedAt: null },
			orderBy: { pinnedAt: 'asc' },
			select: { content: true },
		});
		return rows.map((r) => r.content);
	}

	/** Messages waiting for the agent, oldest first, with each author's name and role. */
	async queuedInput(
		sessionId: string,
		modes: MessageMode[],
	): Promise<QueuedInput[]> {
		const messages = await this.prisma.message.findMany({
			where: { sessionId, status: MessageStatus.QUEUED, mode: { in: modes } },
			orderBy: { createdAt: 'asc' },
			include: { author: { select: { firstname: true, lastname: true } } },
		});
		const roles = await this.roles(sessionId);
		return messages.map((m) => ({
			messageId: m.id,
			authorId: m.authorId,
			author: `${m.author.firstname} ${m.author.lastname}`.trim(),
			role: roles.get(m.authorId) ?? 'former member',
			mode: m.mode as MessageMode,
			content: m.content,
			anchor: m.anchor,
			planStepId: m.planStepId,
		}));
	}

	async roles(sessionId: string): Promise<Map<string, string>> {
		const members = await this.prisma.sessionMember.findMany({
			where: { sessionId },
			select: { userId: true, role: true },
		});
		return new Map(members.map((m) => [m.userId, m.role]));
	}
}
