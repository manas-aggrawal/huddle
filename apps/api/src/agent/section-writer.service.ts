import { randomUUID } from 'node:crypto';
import { ActorType, AgentState, EventType, StepStatus } from '@huddle/shared';
import { Inject, Injectable } from '@nestjs/common';
import { PlanStep } from '@prisma/client';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { LlmService } from '@src/llm/llm.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { AGENT_OPTIONS, type AgentOptions } from './agent.options';
import { AgentContextService } from './agent-context.service';
import { AgentRun } from './agent-run';
import { AgentStateService } from './agent-state.service';
import { AGENT_SYSTEM, sectionPrompt } from './prompts';
import { type ResearchResult, ResearchService } from './research.service';

const EXCERPT_CHARS = 500;

/**
 * Buffers streamed text and writes it into the doc in batches. A paragraph
 * break split across two chunks ("\n" + "\n") is held back until it's whole.
 */
class DocStreamBuffer {
	private pending = '';
	private lastFlush = Date.now();
	private started = false;

	constructor(
		private readonly write: (chunk: string) => Promise<void>,
		private readonly flushMs: number,
	) {}

	async push(delta: string) {
		this.pending += delta;
		if (!this.started) {
			// Models sometimes open with a heading or blank lines despite the prompt.
			const cleaned = this.pending.replace(/^\s*(#{1,6} [^\n]*\n+)?\s*/, '');
			const tooEarly = !this.pending.includes('\n') && this.pending.length < 40;
			if (cleaned.length === 0 || tooEarly) return;
			this.pending = cleaned;
			this.started = true;
		}
		if (Date.now() - this.lastFlush >= this.flushMs) await this.flush(false);
	}

	async flush(final: boolean) {
		let chunk = this.pending;
		if (!final) {
			const trailing = chunk.match(/\n+$/)?.[0] ?? '';
			chunk = chunk.slice(0, chunk.length - trailing.length);
			this.pending = trailing;
		} else {
			chunk = chunk.replace(/\s+$/, '');
			this.pending = '';
		}
		this.lastFlush = Date.now();
		if (!chunk) return;
		await this.write(chunk);
	}
}

/** Writes one plan step's section into the doc, streaming as the model writes. */
@Injectable()
export class SectionWriterService {
	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly llm: LlmService,
		private readonly doc: AgentDocWriter,
		private readonly agentState: AgentStateService,
		private readonly context: AgentContextService,
		private readonly researcher: ResearchService,
		@Inject(AGENT_OPTIONS) private readonly options: AgentOptions,
	) {}

	/** Returns false when the write was cut off (pause, interrupt); the step stays IN_PROGRESS. */
	async write(run: AgentRun, step: PlanStep): Promise<boolean> {
		const { sessionId } = run;
		const started = await this.start(sessionId, step);
		const sectionId = started.sectionId as string;
		await this.ensureSection(sessionId, started);
		let research: ResearchResult | undefined;
		if (this.options.research) {
			research = await this.researcher.research(run, started);
			if (run.aborted) return false;
		}
		await this.agentState.set(sessionId, AgentState.THINKING, step.id);

		const [session, steps, decisions, sections, guidance] = await Promise.all([
			this.prisma.session.findUniqueOrThrow({ where: { id: sessionId } }),
			this.prisma.planStep.findMany({
				where: { sessionId, status: { not: StepStatus.SKIPPED } },
				orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
			}),
			this.context.activeDecisions(sessionId),
			this.doc.listSections(sessionId),
			this.context.guidance(sessionId),
		]);
		const doneSections = new Set(
			steps
				.filter((s) => s.status === StepStatus.DONE && s.sectionId)
				.map((s) => s.sectionId),
		);
		const existing =
			sections.find((s) => s.sectionId === sectionId)?.text ?? '';
		const humanText = await this.context.humanPassages(sessionId, steps);

		const { result } = await this.llm.stream({
			sessionId,
			purpose: 'section',
			system: AGENT_SYSTEM,
			prompt: sectionPrompt({
				goal: session.goal,
				steps,
				step: started,
				decisions,
				guidance,
				previous: sections
					.filter((s) => doneSections.has(s.sectionId))
					.map((s) => ({
						title: s.title,
						excerpt:
							s.text.length > EXCERPT_CHARS
								? `${s.text.slice(0, EXCERPT_CHARS)}…`
								: s.text,
					})),
				existing,
				humanText,
				research,
			}),
			abortSignal: run.signal,
		});

		await this.agentState.set(sessionId, AgentState.WRITING, step.id);
		// A continuation starts a new paragraph rather than gluing onto the old text.
		let separator = existing.trim() ? '\n\n' : '';
		const buffer = new DocStreamBuffer(async (chunk) => {
			await this.doc.appendToSection(sessionId, sectionId, separator + chunk);
			separator = '';
		}, this.options.flushMs);
		try {
			for await (const delta of result.textStream) {
				if (run.aborted) break;
				await buffer.push(delta);
			}
		} catch (err) {
			if (!run.aborted) throw err;
		}
		await buffer.flush(true);
		if (run.aborted) return false;

		await this.timeline.transaction(async (tx) => {
			await tx.planStep.update({
				where: { id: step.id },
				data: { status: StepStatus.DONE },
			});
			await this.timeline.append(tx, sessionId, {
				type: EventType.STEP_COMPLETED,
				actorType: ActorType.AGENT,
				payload: {
					stepId: step.id,
					title: started.title,
					position: started.position,
					sectionId,
				},
			});
			await this.agentState.say(
				sessionId,
				`Finished “${started.title}”.`,
				{ stepId: step.id },
				tx,
			);
		});
		return true;
	}

	/** Marks the step IN_PROGRESS (once) and gives it a section id. */
	private async start(sessionId: string, step: PlanStep): Promise<PlanStep> {
		if (step.status === StepStatus.IN_PROGRESS && step.sectionId) return step;
		return this.timeline.transaction(async (tx) => {
			const updated = await tx.planStep.update({
				where: { id: step.id },
				data: {
					status: StepStatus.IN_PROGRESS,
					sectionId: step.sectionId ?? `sec_${randomUUID().slice(0, 8)}`,
				},
			});
			if (step.status !== StepStatus.IN_PROGRESS) {
				await this.timeline.append(tx, sessionId, {
					type: EventType.STEP_STARTED,
					actorType: ActorType.AGENT,
					payload: {
						stepId: step.id,
						title: updated.title,
						position: updated.position,
						sectionId: updated.sectionId,
					},
				});
			}
			return updated;
		});
	}

	/**
	 * Adds the step's heading unless it's already there (resuming after a
	 * restart). It goes after the nearest earlier step's section, so the doc
	 * follows the plan order even when steps are added or moved.
	 */
	private async ensureSection(sessionId: string, step: PlanStep) {
		const sectionId = step.sectionId as string;
		if (await this.doc.hasSection(sessionId, sectionId)) return;
		const steps = await this.prisma.planStep.findMany({
			where: { sessionId, sectionId: { not: null } },
			orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
		});
		const index = steps.findIndex((s) => s.id === step.id);
		const present = new Set(
			(await this.doc.listSections(sessionId)).map((s) => s.sectionId),
		);
		const after = steps
			.slice(0, index)
			.reverse()
			.find((s) => present.has(s.sectionId as string));
		const before = steps
			.slice(index + 1)
			.find((s) => present.has(s.sectionId as string));
		await this.doc.insertSection(sessionId, sectionId, step.title, {
			after: after?.sectionId,
			before: before?.sectionId,
		});
	}
}
