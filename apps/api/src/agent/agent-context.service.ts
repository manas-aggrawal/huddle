import { MessageMode, MessageStatus } from '@huddle/shared';
import { Injectable } from '@nestjs/common';
import { PlanStep } from '@prisma/client';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
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
	constructor(
		private readonly prisma: PrismaService,
		private readonly doc: AgentDocWriter,
	) {}

	/**
	 * Text people wrote in each section, by step number, so prompts can say
	 * "don't change these" and rewrites know what needs asking.
	 */
	async humanPassages(
		sessionId: string,
		steps: PlanStep[],
	): Promise<
		{ position: number; title: string; author: string; text: string }[]
	> {
		const users = new Map<string, string>();
		const out: {
			position: number;
			title: string;
			author: string;
			text: string;
		}[] = [];
		for (const [i, step] of steps.entries()) {
			if (!step.sectionId) continue;
			if (!(await this.doc.hasSection(sessionId, step.sectionId))) continue;
			for (const r of await this.doc.getHumanOwnedRanges(
				sessionId,
				step.sectionId,
			)) {
				if (!r.text.trim()) continue;
				if (!users.has(r.userId)) {
					const u = await this.prisma.user.findUnique({
						where: { id: r.userId },
						select: { firstname: true, lastname: true },
					});
					users.set(
						r.userId,
						u ? `${u.firstname} ${u.lastname}`.trim() : 'Someone',
					);
				}
				out.push({
					position: i + 1,
					title: step.title,
					author: users.get(r.userId) as string,
					text: r.text,
				});
			}
		}
		return out;
	}

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

	/** Suggestions the agent agreed to follow, so later sections keep following them. */
	async guidance(sessionId: string): Promise<TeamInput[]> {
		const messages = await this.prisma.message.findMany({
			where: {
				sessionId,
				status: MessageStatus.APPLIED,
				mode: { in: [MessageMode.SUGGEST, MessageMode.INTERRUPT] },
			},
			orderBy: { createdAt: 'asc' },
			include: { author: { select: { firstname: true, lastname: true } } },
		});
		const roles = await this.roles(sessionId);
		return messages.map((m) => ({
			author: `${m.author.firstname} ${m.author.lastname}`.trim(),
			role: roles.get(m.authorId) ?? 'former member',
			content: m.content,
		}));
	}

	/** Input the agent is already following, with ids, so new input can be checked against it. */
	async followedInput(sessionId: string): Promise<QueuedInput[]> {
		const messages = await this.prisma.message.findMany({
			where: {
				sessionId,
				status: MessageStatus.APPLIED,
				mode: {
					in: [MessageMode.SUGGEST, MessageMode.INTERRUPT, MessageMode.COMMENT],
				},
			},
			orderBy: { createdAt: 'desc' },
			take: 20,
			include: { author: { select: { firstname: true, lastname: true } } },
		});
		const roles = await this.roles(sessionId);
		return messages.reverse().map((m) => ({
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
