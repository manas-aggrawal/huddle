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
import { ConflictService } from '@src/conflict/conflict.service';
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
import { RewriteService } from './rewrite.service';

export const QueueDecisionSchema = z.object({
	/** Inputs that contradict each other: the Owner decides, the agent doesn't. */
	conflicts: z
		.array(
			z.object({
				messageIds: z.array(z.string()).min(2).max(10),
				summary: z.string().trim().min(1).max(500),
				/** The step it affects, by number; that step waits until it's settled. */
				position: z.number().int().min(1).nullish(),
			}),
		)
		.max(5)
		.nullish(),
	decisions: z.array(
		z.object({
			messageId: z.string(),
			decision: z.enum(['apply', 'plan_change', 'decline']),
			reply: z.string().trim().min(1).max(1000),
			planOps: z.array(PlanOpSchema).max(20).nullish(),
			/** Change text already in a written section. */
			rewrite: z
				.object({
					position: z.number().int().min(1),
					before: z.string().min(1).max(4000),
					after: z.string().max(8000),
				})
				.nullish(),
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
		private readonly rewrites: RewriteService,
		private readonly conflicts: ConflictService,
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
		const humanText = await this.context.humanPassages(sessionId, steps);
		const following = await this.context.followedInput(sessionId);

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
					humanText,
					following,
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

		// Rewrites touch the doc, not the database, so they run first; one that
		// hits a person's text becomes an approval instead.
		const outcomes = new Map<string, string>();
		for (const d of result.decisions) {
			if (!d.rewrite || d.decision === 'decline') continue;
			const step = steps[d.rewrite.position - 1];
			if (!step) continue;
			const outcome = await this.rewrites.propose(
				sessionId,
				step,
				d.rewrite.before,
				d.rewrite.after,
			);
			outcomes.set(d.messageId, outcome);
		}

		const byId = new Map(result.decisions.map((d) => [d.messageId, d]));
		const queuedIds = new Set(queued.map((m) => m.messageId));
		await this.timeline.transaction(async (tx) => {
			// Conflicts first: their step is blocked before anything else changes.
			const inConflict = new Map<string, string[]>();
			for (const c of result.conflicts ?? []) {
				if (!c.messageIds.some((id) => queuedIds.has(id))) continue;
				const raised = await this.conflicts.raise(tx, sessionId, {
					summary: c.summary,
					messageIds: c.messageIds,
					planStepId: c.position ? steps[c.position - 1]?.id : null,
				});
				if (!raised) continue;
				for (const id of c.messageIds) inConflict.set(id, c.messageIds);
			}
			for (const input of queued) {
				const others = inConflict.get(input.messageId);
				if (!others) continue;
				await this.handleConflicted(tx, sessionId, input, others);
			}

			for (const input of queued) {
				// Still queued? (Another pass may have handled it meanwhile.)
				const fresh = await tx.message.findUnique({
					where: { id: input.messageId },
					select: { status: true },
				});
				if (fresh?.status !== MessageStatus.QUEUED) continue;
				if (inConflict.has(input.messageId)) continue;
				const decision = byId.get(input.messageId);
				await this.handle(
					tx,
					sessionId,
					input,
					decision,
					outcomes.get(input.messageId),
				);
			}
		});
	}

	/** Inputs caught in a conflict wait for the Owner; tell their authors so. */
	private async handleConflicted(
		tx: Prisma.TransactionClient,
		sessionId: string,
		input: QueuedInput,
		conflictIds: string[],
	) {
		const firstName = input.author.split(' ')[0];
		const otherAuthors = await tx.message.findMany({
			where: { id: { in: conflictIds.filter((id) => id !== input.messageId) } },
			include: { author: { select: { firstname: true } } },
		});
		const names =
			[...new Set(otherAuthors.map((m) => m.author.firstname))].join(' and ') ||
			'someone else';
		const reply = `${firstName}, that contradicts what ${names} asked for, so I’ve flagged it for the Owner to decide.`;
		await tx.message.updateMany({
			where: { id: input.messageId, status: MessageStatus.QUEUED },
			data: { status: MessageStatus.ACKNOWLEDGED, response: reply },
		});
		await this.timeline.append(tx, sessionId, {
			type: EventType.AGENT_ACK,
			actorType: ActorType.AGENT,
			payload: {
				messageId: input.messageId,
				author: { id: input.authorId, name: input.author },
				mode: input.mode,
				status: MessageStatus.ACKNOWLEDGED,
				decision: 'conflict',
				reply,
			},
		});
	}

	private async handle(
		tx: Prisma.TransactionClient,
		sessionId: string,
		input: QueuedInput,
		decision: QueueDecision | undefined,
		rewrite?: string,
	) {
		const firstName = input.author.split(' ')[0];
		// The model skipped it: acknowledge rather than leave it hanging.
		let status = decision
			? STATUS_FOR[decision.decision]
			: MessageStatus.ACKNOWLEDGED;
		let reply = decision?.reply ?? `Noted, ${firstName}.`;
		if (rewrite === 'asked') {
			status = MessageStatus.ACKNOWLEDGED;
			reply = `${reply} That changes text a person wrote, so I’ve asked for approval first.`;
		} else if (rewrite === 'not_found') {
			reply = `${reply} (I couldn’t find the exact text to change.)`;
		}

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
