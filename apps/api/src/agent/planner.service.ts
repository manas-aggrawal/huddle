import {
	ActorType,
	AgentState,
	ApprovalKind,
	ApprovalStatus,
	EventType,
	MessageMode,
	MessageStatus,
	SessionStatus,
	StepStatus,
} from '@huddle/shared';
import { Injectable } from '@nestjs/common';
import { ApprovalService } from '@src/approval/approval.service';
import { LlmService } from '@src/llm/llm.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { z } from 'zod';
import { AgentContextService } from './agent-context.service';
import { AgentRun } from './agent-run';
import { AgentStateService } from './agent-state.service';
import { generateJson } from './json-output';
import { AGENT_SYSTEM, outlinePrompt, type PlanStepBrief } from './prompts';

export const OutlineSchema = z.object({
	steps: z
		.array(
			z.object({
				title: z.string().trim().min(1).max(200),
				description: z.string().trim().max(1000).optional().nullable(),
			}),
		)
		.min(1)
		.max(12),
});

/** Drafts the outline, saves it as plan steps and asks for it to be approved. */
@Injectable()
export class PlannerService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly llm: LlmService,
		private readonly approvals: ApprovalService,
		private readonly agentState: AgentStateService,
		private readonly context: AgentContextService,
	) {}

	async plan(run: AgentRun): Promise<void> {
		const { sessionId } = run;
		await this.agentState.set(sessionId, AgentState.THINKING);

		const session = await this.prisma.session.findUniqueOrThrow({
			where: { id: sessionId },
		});
		const queued = await this.context.queuedInput(sessionId, [
			MessageMode.SUGGEST,
			MessageMode.COMMENT,
			MessageMode.INTERRUPT,
		]);
		const decisions = await this.context.activeDecisions(sessionId);
		const rejected = await this.lastRejectedOutline(sessionId);

		const outline = await generateJson(
			this.llm,
			{
				sessionId,
				purpose: 'outline',
				system: AGENT_SYSTEM,
				prompt: outlinePrompt({
					title: session.title,
					goal: session.goal,
					teamInput: queued,
					decisions,
					rejected,
				}),
				abortSignal: run.signal,
			},
			OutlineSchema,
		);
		if (run.aborted) return;

		await this.timeline.transaction(async (tx) => {
			const current = await tx.session.findUniqueOrThrow({
				where: { id: sessionId },
				select: { status: true },
			});
			// Ended or already planned while we were thinking: keep what's there.
			if (
				current.status !== SessionStatus.PLANNING &&
				current.status !== SessionStatus.PAUSED
			) {
				return;
			}
			const replaced = await tx.planStep.findMany({
				where: { sessionId, status: StepStatus.PENDING },
				select: { title: true },
			});
			await tx.planStep.deleteMany({
				where: { sessionId, status: StepStatus.PENDING },
			});
			const kept = await tx.planStep.count({ where: { sessionId } });
			await tx.planStep.createMany({
				data: outline.steps.map((s, i) => ({
					sessionId,
					position: kept + i + 1,
					title: s.title,
					description: s.description ?? null,
				})),
			});

			// The team's early input went into the outline: say so, by name.
			for (const input of queued) {
				const reply = `Thanks ${input.author.split(' ')[0]}, I used that in the outline.`;
				await tx.message.update({
					where: { id: input.messageId },
					data: {
						status: MessageStatus.APPLIED,
						response: reply,
						processedAt: new Date(),
					},
				});
				await this.timeline.append(tx, sessionId, {
					type: EventType.AGENT_ACK,
					actorType: ActorType.AGENT,
					payload: {
						messageId: input.messageId,
						author: { id: input.authorId, name: input.author },
						status: MessageStatus.APPLIED,
						reply,
					},
				});
			}

			await this.timeline.append(tx, sessionId, {
				type: EventType.PLAN_UPDATED,
				actorType: ActorType.AGENT,
				payload: {
					reason: rejected ? 'revised' : 'outline',
					diff: {
						added: outline.steps.map((s) => s.title),
						removed: replaced.map((s) => s.title),
					},
				},
			});
			await this.approvals.request(tx, sessionId, {
				kind: ApprovalKind.OUTLINE,
				title: rejected ? 'Approve the revised outline' : 'Approve the outline',
				details: {
					steps: outline.steps.map((s) => ({
						title: s.title,
						description: s.description ?? null,
					})),
				},
			});
		});
		await this.agentState.set(sessionId, AgentState.IDLE);
	}

	/** The latest outline approval, if it was rejected: the revision answers it. */
	private async lastRejectedOutline(
		sessionId: string,
	): Promise<
		{ steps: PlanStepBrief[]; note: string | null; by: string } | undefined
	> {
		const last = await this.prisma.approval.findFirst({
			where: { sessionId, kind: ApprovalKind.OUTLINE },
			orderBy: { requestedAt: 'desc' },
			include: { resolvedBy: { select: { firstname: true, lastname: true } } },
		});
		if (!last || last.status !== ApprovalStatus.REJECTED) return undefined;
		const details = (last.details ?? {}) as { steps?: PlanStepBrief[] };
		return {
			steps: (details.steps ?? []).map((s, i) => ({ ...s, position: i + 1 })),
			note: last.note,
			by: last.resolvedBy
				? `${last.resolvedBy.firstname} ${last.resolvedBy.lastname}`.trim()
				: 'The team',
		};
	}
}
