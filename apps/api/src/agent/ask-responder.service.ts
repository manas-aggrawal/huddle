import {
	ActorType,
	EventType,
	MessageMode,
	MessageStatus,
	StepStatus,
} from '@huddle/shared';
import { Injectable, Logger } from '@nestjs/common';
import { AgentDocWriter } from '@src/collab/agent-doc-writer.service';
import { LlmService } from '@src/llm/llm.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { AgentContextService } from './agent-context.service';
import { AGENT_SYSTEM, askPrompt } from './prompts';

const EXCERPT_CHARS = 700;

/**
 * Answers Asks right away, alongside whatever the runner is doing. A question
 * never changes the plan; the answer is a threaded reply on the timeline.
 */
@Injectable()
export class AskResponderService {
	private readonly logger = new Logger(AskResponderService.name);
	/** Messages being answered now, so a replayed event doesn't answer twice. */
	private readonly inFlight = new Set<string>();

	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly llm: LlmService,
		private readonly doc: AgentDocWriter,
		private readonly context: AgentContextService,
	) {}

	/** Answers every unanswered question in the session (after a restart). */
	async answerPending(sessionId: string) {
		const asks = await this.prisma.message.findMany({
			where: { sessionId, mode: MessageMode.ASK, status: MessageStatus.QUEUED },
			select: { id: true },
		});
		await Promise.all(asks.map((a) => this.answer(a.id)));
	}

	async answer(messageId: string): Promise<void> {
		if (this.inFlight.has(messageId)) return;
		this.inFlight.add(messageId);
		try {
			await this.respond(messageId);
		} catch (err) {
			this.logger.error(`Couldn't answer message ${messageId}`, err);
			const message = await this.prisma.message.findUnique({
				where: { id: messageId },
			});
			if (message) {
				await this.timeline
					.record(message.sessionId, {
						type: EventType.AGENT_MESSAGE,
						actorType: ActorType.AGENT,
						payload: {
							text: `I couldn’t answer that just now: ${(err as Error)?.message ?? 'unknown error'}.`,
							kind: 'error',
							replyTo: null,
							about: messageId,
						},
					})
					.catch(() => undefined);
			}
		} finally {
			this.inFlight.delete(messageId);
		}
	}

	private async respond(messageId: string) {
		const message = await this.prisma.message.findUniqueOrThrow({
			where: { id: messageId },
			include: { author: { select: { firstname: true, lastname: true } } },
		});
		if (message.status !== MessageStatus.QUEUED) return;
		const { sessionId } = message;
		const [session, steps, decisions, sections, roles] = await Promise.all([
			this.prisma.session.findUniqueOrThrow({ where: { id: sessionId } }),
			this.prisma.planStep.findMany({
				where: { sessionId, status: { not: StepStatus.SKIPPED } },
				orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
			}),
			this.context.activeDecisions(sessionId),
			this.doc.listSections(sessionId),
			this.context.roles(sessionId),
		]);
		const author =
			`${message.author.firstname} ${message.author.lastname}`.trim();

		const { text } = await this.llm.generate({
			sessionId,
			purpose: 'ask',
			system: AGENT_SYSTEM,
			prompt: askPrompt({
				goal: session.goal,
				steps,
				decisions,
				sections: sections.map((s) => ({
					title: s.title,
					excerpt:
						s.text.length > EXCERPT_CHARS
							? `${s.text.slice(0, EXCERPT_CHARS)}…`
							: s.text,
				})),
				question: {
					author,
					role: roles.get(message.authorId) ?? 'former member',
					content: message.content,
				},
			}),
			maxOutputTokens: 400,
		});
		const answer = text.trim() || 'I don’t have an answer to that yet.';

		await this.timeline.transaction(async (tx) => {
			const { count } = await tx.message.updateMany({
				where: { id: messageId, status: MessageStatus.QUEUED },
				data: {
					status: MessageStatus.ANSWERED,
					response: answer,
					processedAt: new Date(),
				},
			});
			if (count === 0) return;
			await this.timeline.append(tx, sessionId, {
				type: EventType.AGENT_MESSAGE,
				actorType: ActorType.AGENT,
				payload: {
					text: answer,
					replyTo: messageId,
					to: { id: message.authorId, name: author },
					question: message.content,
				},
			});
		});
	}
}
