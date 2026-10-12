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
import { SectionWriterService } from './section-writer.service';

/** What the loop should do next, decided from the session's saved state. */
type NextAction =
	| { kind: 'plan' }
	| { kind: 'queue' }
	| { kind: 'write'; stepId: string }
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
				} else {
					// Picked up at the next section boundary (or now, if idle).
					this.wake(event.sessionId);
				}
				break;
			case EventType.SESSION_CREATED:
			case EventType.APPROVAL_RESOLVED:
				this.wake(event.sessionId);
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

	private async drive(run: AgentRun): Promise<void> {
		const { sessionId } = run;
		try {
			while (!run.stopped) {
				run.wakeAgain = false;
				const next = await this.nextAction(sessionId);
				if (next.kind === 'idle') break;
				try {
					if (next.kind === 'plan') await this.planner.plan(run);
					else if (next.kind === 'queue') await this.queue.process(run);
					else if (next.kind === 'write')
						await this.writeStep(run, next.stepId);
					else await this.requestFinal(sessionId);
				} catch (err) {
					if (run.aborted) continue; // Cut off on purpose; re-read the state.
					await this.reportFailure(sessionId, err);
					break;
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
		if (!session || session.approvals.length > 0) return { kind: 'idle' };
		if (session.status === SessionStatus.PLANNING) return { kind: 'plan' };
		if (session.status !== SessionStatus.RUNNING) return { kind: 'idle' };
		// Between sections, the team's input comes first.
		if (await this.queue.hasQueued(sessionId)) return { kind: 'queue' };

		const next = session.planSteps.find(
			(s) =>
				s.status === StepStatus.IN_PROGRESS || s.status === StepStatus.PENDING,
		);
		if (next) return { kind: 'write', stepId: next.id };
		// Blocked steps wait for a person; the doc isn't finished until they're settled.
		if (session.planSteps.some((s) => s.status === StepStatus.BLOCKED)) {
			return { kind: 'idle' };
		}
		return { kind: 'finish' };
	}

	private async writeStep(run: AgentRun, stepId: string) {
		const step = await this.prisma.planStep.findUniqueOrThrow({
			where: { id: stepId },
		});
		await this.writer.write(run, step);
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
