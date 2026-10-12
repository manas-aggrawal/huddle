import {
	ActorType,
	AgentState,
	ApprovalKind,
	ApprovalStatus,
	BLOCKING_APPROVAL_KINDS,
	EventType,
	MessageMode,
	MessageStatus,
	SessionStatus,
	StepStatus,
} from '@huddle/shared';
import {
	Inject,
	Injectable,
	Logger,
	OnApplicationBootstrap,
	OnModuleDestroy,
} from '@nestjs/common';
import { TimelineEvent } from '@prisma/client';
import { ApprovalService } from '@src/approval/approval.service';
import { BudgetExceededError, PoolExhaustedError } from '@src/llm/errors';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { AGENT_OPTIONS, type AgentOptions } from './agent.options';
import { AgentRun } from './agent-run';
import { AgentStateService } from './agent-state.service';
import { AskResponderService } from './ask-responder.service';
import { InvalidModelOutputError } from './json-output';
import { PlannerService } from './planner.service';
import { QueueProcessorService } from './queue-processor.service';
import { ReplannerService } from './replanner.service';
import { RewriteService } from './rewrite.service';
import { SectionWriterService } from './section-writer.service';

/** What the loop should do next, decided from the session's saved state. */
type NextAction =
	| { kind: 'plan' }
	| { kind: 'queue' }
	| { kind: 'replan' }
	| { kind: 'write'; stepId: string }
	| { kind: 'gate'; stepId: string }
	| { kind: 'finish' }
	| { kind: 'idle' };

/**
 * Runs each session's agent: plan → wait for the outline → write the sections
 * in order → ask to mark the doc final. At most one loop per session runs in
 * this process. The loop is driven by saved state, so it can stop at any point
 * (pause, restart) and pick up where the data says it is.
 *
 * It reacts to the timeline rather than being called by other modules: a new
 * session, an answered approval or a status change wakes it.
 */
@Injectable()
export class AgentRunner implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(AgentRunner.name);
	private readonly runs = new Map<string, AgentRun>();
	private unsubscribe?: () => void;

	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly approvals: ApprovalService,
		private readonly agentState: AgentStateService,
		private readonly planner: PlannerService,
		private readonly writer: SectionWriterService,
		private readonly queue: QueueProcessorService,
		private readonly asks: AskResponderService,
		private readonly replanner: ReplannerService,
		private readonly rewrites: RewriteService,
		@Inject(AGENT_OPTIONS) private readonly options: AgentOptions,
	) {}

	async onApplicationBootstrap() {
		if (!this.options.enabled) return;
		this.unsubscribe = this.timeline.onCommitted((e) => this.onEvent(e));
		// Pick up whatever was in progress when the process last stopped.
		const active = await this.prisma.session.findMany({
			where: {
				status: { in: [SessionStatus.PLANNING, SessionStatus.RUNNING] },
			},
			select: { id: true },
		});
		for (const s of active) this.wake(s.id);
		// Questions asked while the process was down still get answers.
		const unanswered = await this.prisma.message.findMany({
			where: { mode: MessageMode.ASK, status: MessageStatus.QUEUED },
			distinct: ['sessionId'],
			select: { sessionId: true },
		});
		for (const m of unanswered) void this.asks.answerPending(m.sessionId);
	}

	async onModuleDestroy() {
		this.unsubscribe?.();
		const runs = [...this.runs.values()];
		for (const run of runs) run.stop();
		await Promise.all(runs.map((r) => r.done));
	}

	/** Whether a loop is running for the session (for tests and diagnostics). */
	isRunning(sessionId: string): boolean {
		return this.runs.has(sessionId);
	}

	/** Resolves when the session's loop (if any) has exited. */
	async settled(sessionId: string): Promise<void> {
		while (this.runs.has(sessionId)) await this.runs.get(sessionId)?.done;
	}

	/** Starts the session's loop, or tells the running one to look again. Never starts two. */
	wake(sessionId: string): void {
		if (!this.options.enabled) return;
		const existing = this.runs.get(sessionId);
		if (existing) {
			existing.wakeAgain = true;
			return;
		}
		const run = new AgentRun(sessionId);
		this.runs.set(sessionId, run);
		run.done = this.drive(run)
			.catch((err) =>
				this.logger.error(`Agent loop crashed for ${sessionId}`, err),
			)
			.finally(() => {
				this.runs.delete(sessionId);
				if (run.wakeAgain && !run.stopped) this.wake(sessionId);
			});
	}

	private onEvent(event: TimelineEvent) {
		const payload = event.payload as {
			to?: string;
			mode?: string;
			messageId?: string;
		};
		switch (event.type) {
			case EventType.HUMAN_MESSAGE:
				if (payload.mode === MessageMode.ASK && payload.messageId) {
					void this.asks.answer(payload.messageId);
				} else if (
					payload.mode === MessageMode.INTERRUPT &&
					payload.messageId
				) {
					void this.interrupt(event.sessionId, payload.messageId);
				} else {
					// Picked up at the next section boundary (or now, if idle).
					this.wake(event.sessionId);
				}
				break;
			case EventType.APPROVAL_RESOLVED: {
				const p = event.payload as {
					approvalId?: string;
					kind?: string;
					status?: string;
				};
				if (
					p.kind === ApprovalKind.REWRITE_HUMAN_TEXT &&
					p.status === ApprovalStatus.APPROVED &&
					p.approvalId
				) {
					void this.rewrites.applyApproved(p.approvalId);
				}
				this.wake(event.sessionId);
				break;
			}
			case EventType.SESSION_CREATED:
			case EventType.CONFLICT_RESOLVED:
				this.wake(event.sessionId);
				break;
			case EventType.PLAN_UPDATED:
				// A person changed the plan: picked up at the next step (or now, if idle).
				if (event.actorType === ActorType.USER) this.wake(event.sessionId);
				break;
			case EventType.STATUS_CHANGED:
				if (
					payload.to === SessionStatus.PAUSED ||
					payload.to === SessionStatus.DONE
				) {
					// Stop mid-write; the loop then sees the status and exits.
					this.runs.get(event.sessionId)?.abortCurrent('paused');
				} else {
					this.wake(event.sessionId);
				}
				break;
		}
	}

	/**
	 * Stops whatever the agent is writing right now and replans. Interrupts
	 * don't cut off a replan in progress: they queue up and run after it.
	 */
	private async interrupt(sessionId: string, messageId: string) {
		const session = await this.prisma.session.findUnique({
			where: { id: sessionId },
			select: { status: true },
		});
		if (session?.status !== SessionStatus.RUNNING) {
			this.wake(sessionId); // Planning uses it as input; otherwise it waits.
			return;
		}
		const run = this.runs.get(sessionId);
		if (run && (run.phase === 'write' || run.phase === 'queue')) {
			run.abortCurrent('interrupted');
		}
		await this.replanner
			.acknowledge(messageId)
			.catch((err) =>
				this.logger.error(`Couldn't acknowledge interrupt ${messageId}`, err),
			);
		this.wake(sessionId);
	}

	private async drive(run: AgentRun): Promise<void> {
		const { sessionId } = run;
		try {
			while (!run.stopped) {
				run.wakeAgain = false;
				const next = await this.nextAction(sessionId);
				if (next.kind === 'idle') break;
				run.phase = next.kind;
				try {
					if (next.kind === 'plan') await this.planner.plan(run);
					else if (next.kind === 'replan') await this.replanner.replanNext(run);
					else if (next.kind === 'queue') await this.queue.process(run);
					else if (next.kind === 'write')
						await this.writeStep(run, next.stepId);
					else if (next.kind === 'gate')
						await this.requestStepGate(sessionId, next.stepId);
					else await this.requestFinal(sessionId);
				} catch (err) {
					if (run.aborted) continue; // Cut off on purpose; re-read the state.
					await this.reportFailure(sessionId, err);
					break;
				} finally {
					run.phase = null;
				}
			}
		} finally {
			await this.agentState
				.set(sessionId, AgentState.IDLE)
				.catch(() => undefined);
		}
	}

	private async nextAction(sessionId: string): Promise<NextAction> {
		const session = await this.prisma.session.findUnique({
			where: { id: sessionId },
			include: {
				planSteps: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
				approvals: { where: { status: ApprovalStatus.PENDING } },
			},
		});
		if (!session) return { kind: 'idle' };
		const blocked = session.approvals.some((a) =>
			BLOCKING_APPROVAL_KINDS.includes(a.kind as ApprovalKind),
		);
		if (blocked) return { kind: 'idle' };
		if (session.status === SessionStatus.PLANNING) return { kind: 'plan' };
		if (session.status !== SessionStatus.RUNNING) return { kind: 'idle' };
		// Interrupts first, then the team's queued input, then the next section.
		if (await this.replanner.hasPending(sessionId)) return { kind: 'replan' };
		if (await this.queue.hasQueued(sessionId)) return { kind: 'queue' };

		// Steps waiting on their own approval are skipped for now; the rest go on.
		const gated = new Set(
			session.approvals.map((a) => a.planStepId).filter(Boolean),
		);
		const next = session.planSteps.find(
			(s) =>
				(s.status === StepStatus.IN_PROGRESS ||
					s.status === StepStatus.PENDING) &&
				!gated.has(s.id),
		);
		if (next) {
			if (next.requiresApproval && next.status === StepStatus.PENDING) {
				const approved = await this.prisma.approval.count({
					where: {
						planStepId: next.id,
						kind: ApprovalKind.CUSTOM,
						status: ApprovalStatus.APPROVED,
					},
				});
				if (!approved) return { kind: 'gate', stepId: next.id };
			}
			return { kind: 'write', stepId: next.id };
		}
		// Blocked or gated steps wait for a person; the doc isn't finished until they're settled.
		const waiting = session.planSteps.some(
			(s) => s.status === StepStatus.BLOCKED || gated.has(s.id),
		);
		if (waiting) return { kind: 'idle' };
		return { kind: 'finish' };
	}

	private async writeStep(run: AgentRun, stepId: string) {
		const step = await this.prisma.planStep.findUniqueOrThrow({
			where: { id: stepId },
		});
		await this.writer.write(run, step);
	}

	/** A step marked "needs approval" waits for a CUSTOM approval before it's written. */
	private async requestStepGate(sessionId: string, stepId: string) {
		await this.timeline.transaction(async (tx) => {
			const step = await tx.planStep.findUniqueOrThrow({
				where: { id: stepId },
			});
			await this.approvals.request(tx, sessionId, {
				kind: ApprovalKind.CUSTOM,
				title: `Start “${step.title}”?`,
				details: { reason: 'step_gate', stepTitle: step.title },
				planStepId: stepId,
			});
		});
	}

	private async requestFinal(sessionId: string) {
		await this.timeline.transaction(async (tx) => {
			await this.agentState.say(
				sessionId,
				'Every section is written. Review the document and mark it final when it’s ready.',
				{},
				tx,
			);
			await this.approvals.request(tx, sessionId, {
				kind: ApprovalKind.MARK_FINAL,
				title: 'Mark the document final',
			});
		});
	}

	/** Tells the room why the agent stopped. It picks up again when the Owner resumes. */
	private async reportFailure(sessionId: string, err: unknown) {
		let text: string;
		if (err instanceof PoolExhaustedError) {
			text =
				'I’ve stopped: the workspace has used its token allowance for this period.';
		} else if (err instanceof BudgetExceededError) {
			text = `I’ve stopped: this session reached its token cap (${err.budget.toLocaleString('en-US')} tokens).`;
		} else if (err instanceof InvalidModelOutputError) {
			text =
				'I couldn’t produce a usable outline (the model’s reply wasn’t valid). Pause and resume the session to try again.';
		} else {
			this.logger.error(`Agent failed for session ${sessionId}`, err);
			text = `Something went wrong and I’ve stopped: ${(err as Error)?.message ?? String(err)}. Pause and resume the session to try again.`;
		}
		await this.timeline
			.record(sessionId, {
				type: EventType.AGENT_MESSAGE,
				actorType: ActorType.AGENT,
				payload: { text, kind: 'error' },
			})
			.catch(() => undefined);
	}
}
