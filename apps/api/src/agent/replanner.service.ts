import {
	ActorType,
	AgentState,
	EventType,
	MessageMode,
	MessageStatus,
	StepStatus,
} from '@huddle/shared';
import { Injectable } from '@nestjs/common';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { LlmService } from '@src/llm/llm.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { z } from 'zod';
import { AgentContextService } from './agent-context.service';
import { AgentRun } from './agent-run';
import { AgentStateService } from './agent-state.service';
import { generateJson } from './json-output';
import { applyPlanOps, PlanOpSchema, summarizeDiff } from './plan-ops';
import { AGENT_SYSTEM, replanPrompt } from './prompts';

const ReplanSchema = z.object({
	reply: z.string().trim().min(1).max(1000),
	planOps: z.array(PlanOpSchema).max(20).nullish(),
});

/** Interrupts not yet replanned for, oldest first. */
const pendingWhere = (sessionId: string) => ({
	sessionId,
	mode: MessageMode.INTERRUPT,
	processedAt: null,
	status: { in: [MessageStatus.QUEUED, MessageStatus.ACKNOWLEDGED] },
});

/**
 * Handles Interrupts. The runner stops the current write the moment one
 * arrives; this then replans with it, one interrupt at a time, oldest first.
 */
@Injectable()
export class ReplannerService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly llm: LlmService,
		private readonly doc: AgentDocWriter,
		private readonly agentState: AgentStateService,
		private readonly context: AgentContextService,
	) {}

	async hasPending(sessionId: string): Promise<boolean> {
		return (
			(await this.prisma.message.count({ where: pendingWhere(sessionId) })) > 0
		);
	}

	/** "Stopping": shown on the message right away, before the replan finishes. */
	async acknowledge(messageId: string) {
		await this.timeline.transaction(async (tx) => {
			const message = await tx.message.findUnique({
				where: { id: messageId },
				include: { author: { select: { firstname: true, lastname: true } } },
			});
			if (!message || message.status !== MessageStatus.QUEUED) return;
			await tx.message.update({
				where: { id: messageId },
				data: { status: MessageStatus.ACKNOWLEDGED },
			});
			const name =
				`${message.author.firstname} ${message.author.lastname}`.trim();
			await this.timeline.append(tx, message.sessionId, {
				type: EventType.AGENT_ACK,
				actorType: ActorType.AGENT,
				payload: {
					messageId,
					author: { id: message.authorId, name },
					mode: MessageMode.INTERRUPT,
					status: MessageStatus.ACKNOWLEDGED,
					reply: `Stopping, ${name.split(' ')[0]}. Replanning with your note.`,
				},
			});
		});
	}

	/** Replans for the oldest pending interrupt. */
	async replanNext(run: AgentRun): Promise<void> {
		const { sessionId } = run;
		const message = await this.prisma.message.findFirst({
			where: pendingWhere(sessionId),
			orderBy: { createdAt: 'asc' },
			include: { author: { select: { firstname: true, lastname: true } } },
		});
		if (!message) return;
		await this.agentState.set(sessionId, AgentState.THINKING);

		// The cut-off step goes back to PENDING; what it wrote stays in the doc.
		const stopped = await this.prisma.planStep.findFirst({
			where: { sessionId, status: StepStatus.IN_PROGRESS },
		});
		if (stopped) {
			await this.prisma.planStep.update({
				where: { id: stopped.id },
				data: { status: StepStatus.PENDING },
			});
		}

		const [session, steps, decisions, roles] = await Promise.all([
			this.prisma.session.findUniqueOrThrow({ where: { id: sessionId } }),
			this.prisma.planStep.findMany({
				where: { sessionId },
				orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
			}),
			this.context.activeDecisions(sessionId),
			this.context.roles(sessionId),
		]);
		const author =
			`${message.author.firstname} ${message.author.lastname}`.trim();
		let interrupted: { title: string; text: string } | undefined;
		if (
			stopped?.sectionId &&
			(await this.doc.hasSection(sessionId, stopped.sectionId))
		) {
			interrupted = {
				title: stopped.title,
				text: await this.doc.getSectionText(sessionId, stopped.sectionId),
			};
		}

		// Not cut off by later interrupts: each one waits its turn.
		const result = await generateJson(
			this.llm,
			{
				sessionId,
				purpose: 'replan',
				system: AGENT_SYSTEM,
				prompt: replanPrompt({
					goal: session.goal,
					steps,
					decisions,
					interrupt: {
						author,
						role: roles.get(message.authorId) ?? 'former member',
						content: message.content,
					},
					interrupted,
				}),
			},
			ReplanSchema,
		);

		await this.timeline.transaction(async (tx) => {
			const diff = await applyPlanOps(tx, sessionId, result.planOps ?? []);
			await this.timeline.append(tx, sessionId, {
				type: EventType.PLAN_UPDATED,
				actorType: ActorType.AGENT,
				payload: {
					reason: 'interrupt',
					messageId: message.id,
					by: { id: message.authorId, name: author },
					diff: { ...diff },
					summary: summarizeDiff(diff) || 'No changes to the steps',
				},
			});
			await tx.message.update({
				where: { id: message.id },
				data: {
					status: MessageStatus.APPLIED,
					response: result.reply,
					processedAt: new Date(),
				},
			});
			await this.timeline.append(tx, sessionId, {
				type: EventType.AGENT_ACK,
				actorType: ActorType.AGENT,
				payload: {
					messageId: message.id,
					author: { id: message.authorId, name: author },
					mode: MessageMode.INTERRUPT,
					status: MessageStatus.APPLIED,
					reply: result.reply,
				},
			});
		});
	}
}
