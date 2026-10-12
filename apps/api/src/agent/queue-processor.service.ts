import {
	ActorType,
	AgentState,
	EventType,
	MessageMode,
	MessageStatus,
	StepStatus,
} from '@huddle/shared';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { LlmService } from '@src/llm/llm.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { z } from 'zod';
import { AgentContextService, type QueuedInput } from './agent-context.service';
import { AgentRun } from './agent-run';
import { AgentStateService } from './agent-state.service';
import { generateJson } from './json-output';
import {
	applyPlanOps,
	diffIsEmpty,
	PlanOpSchema,
	summarizeDiff,
} from './plan-ops';
import { AGENT_SYSTEM, queuePrompt } from './prompts';

export const QueueDecisionSchema = z.object({
	decisions: z.array(
		z.object({
			messageId: z.string(),
			decision: z.enum(['apply', 'plan_change', 'decline']),
			reply: z.string().trim().min(1).max(1000),
			planOps: z.array(PlanOpSchema).max(20).nullish(),
		}),
	),
});
type QueueDecision = z.infer<typeof QueueDecisionSchema>['decisions'][number];

const STATUS_FOR: Record<QueueDecision['decision'], MessageStatus> = {
	apply: MessageStatus.APPLIED,
	plan_change: MessageStatus.APPLIED,
	decline: MessageStatus.DECLINED,
};

/** The modes handled at section boundaries (Asks and Interrupts are handled at once). */
export const QUEUED_MODES: MessageMode[] = [
	MessageMode.SUGGEST,
	MessageMode.COMMENT,
];

/**
 * Between sections, reads the team's queued suggestions and comments and
 * decides, through the model, what to do with each: follow it, change the
 * plan, or decline. Replies to each person by name.
 */
@Injectable()
export class QueueProcessorService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly llm: LlmService,
		private readonly doc: AgentDocWriter,
		private readonly agentState: AgentStateService,
		private readonly context: AgentContextService,
	) {}

	hasQueued(sessionId: string): Promise<boolean> {
		return this.prisma.message
			.count({
				where: {
					sessionId,
					status: MessageStatus.QUEUED,
					mode: { in: QUEUED_MODES },
				},
			})
			.then((n) => n > 0);
	}

	async process(run: AgentRun): Promise<void> {
		const { sessionId } = run;
		const queued = await this.context.queuedInput(sessionId, QUEUED_MODES);
		if (queued.length === 0) return;
		await this.agentState.set(sessionId, AgentState.THINKING);

		const [session, steps, decisions, sections] = await Promise.all([
			this.prisma.session.findUniqueOrThrow({ where: { id: sessionId } }),
			this.prisma.planStep.findMany({
				where: { sessionId },
				orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
			}),
			this.context.activeDecisions(sessionId),
			this.doc.listSections(sessionId),
		]);
		const sectionTitle = new Map(sections.map((s) => [s.sectionId, s.title]));

		const result = await generateJson(
			this.llm,
			{
				sessionId,
				purpose: 'queue',
				system: AGENT_SYSTEM,
				prompt: queuePrompt({
					goal: session.goal,
					steps,
					decisions,
					messages: queued.map((m) => {
						const anchor = (m.anchor ?? {}) as {
							quote?: string;
							sectionId?: string;
						};
						return {
							...m,
							quote: anchor.quote,
							section: anchor.sectionId
								? sectionTitle.get(anchor.sectionId)
								: undefined,
						};
					}),
				}),
				abortSignal: run.signal,
			},
			QueueDecisionSchema,
		);
		if (run.aborted) return;

		const byId = new Map(result.decisions.map((d) => [d.messageId, d]));
		await this.timeline.transaction(async (tx) => {
			for (const input of queued) {
				// Still queued? (Another pass may have handled it meanwhile.)
				const fresh = await tx.message.findUnique({
					where: { id: input.messageId },
					select: { status: true },
				});
				if (fresh?.status !== MessageStatus.QUEUED) continue;
				const decision = byId.get(input.messageId);
				await this.handle(tx, sessionId, input, decision);
			}
		});
	}

	private async handle(
		tx: Prisma.TransactionClient,
		sessionId: string,
		input: QueuedInput,
		decision: QueueDecision | undefined,
	) {
		const firstName = input.author.split(' ')[0];
		// The model skipped it: acknowledge rather than leave it hanging.
		const status = decision
			? STATUS_FOR[decision.decision]
			: MessageStatus.ACKNOWLEDGED;
		const reply = decision?.reply ?? `Noted, ${firstName}.`;

		if (decision?.decision === 'plan_change' && decision.planOps?.length) {
			const diff = await applyPlanOps(tx, sessionId, decision.planOps);
			if (!diffIsEmpty(diff)) {
				await this.timeline.append(tx, sessionId, {
					type: EventType.PLAN_UPDATED,
					actorType: ActorType.AGENT,
					payload: {
						reason: 'suggestion',
						messageId: input.messageId,
						by: { id: input.authorId, name: input.author },
						diff: { ...diff },
						summary: summarizeDiff(diff),
					},
				});
			}
		}

		await tx.message.update({
			where: { id: input.messageId },
			data: { status, response: reply, processedAt: new Date() },
		});
		await this.timeline.append(tx, sessionId, {
			type: EventType.AGENT_ACK,
			actorType: ActorType.AGENT,
			payload: {
				messageId: input.messageId,
				author: { id: input.authorId, name: input.author },
				mode: input.mode,
				status,
				decision: decision?.decision ?? null,
				reply,
			},
		});
	}
}
