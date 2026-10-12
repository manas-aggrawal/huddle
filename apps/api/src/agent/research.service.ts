import { ActorType, AgentState, EventType } from '@huddle/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PlanStep } from '@prisma/client';
import { LlmService } from '@src/llm/llm.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { SearchService } from '@src/research/search.service';
import { TimelineService } from '@src/timeline/timeline.service';
import { tool } from 'ai';
import { z } from 'zod';
import { AgentContextService } from './agent-context.service';
import { AgentRun } from './agent-run';
import { AgentStateService } from './agent-state.service';
import { AGENT_SYSTEM, researchPrompt } from './prompts';

export interface ResearchResult {
	notes: string;
	/** Pages read for this section, numbered as the doc's Sources list numbers them. */
	sources: { n: number; title: string; url: string }[];
}

const errorText = (err: unknown) =>
	err instanceof Error
		? err.name === 'TimeoutError' || err.name === 'AbortError'
			? 'it timed out'
			: err.message
		: String(err);

/**
 * Before each section, a tool-using call gathers facts (web search now,
 * reading pages next) and returns notes. Writing then happens without tools,
 * so tool chatter never lands in the doc. Every tool call is on the timeline.
 */
@Injectable()
export class ResearchService {
	private readonly logger = new Logger(ResearchService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly llm: LlmService,
		private readonly search: SearchService,
		private readonly agentState: AgentStateService,
		private readonly context: AgentContextService,
	) {}

	/** The tools the agent can call while researching one step. */
	tools(run: AgentRun, step: PlanStep) {
		return {
			web_search: tool({
				description:
					'Search the web. Returns the top results (title, url, snippet). Use focused queries.',
				inputSchema: z.object({
					query: z
						.string()
						.trim()
						.min(2)
						.max(200)
						.describe('What to search for'),
				}),
				execute: async ({ query }) =>
					this.webSearch(run.sessionId, step, query),
			}),
		};
	}

	async research(run: AgentRun, step: PlanStep): Promise<ResearchResult> {
		const { sessionId } = run;
		await this.agentState.set(sessionId, AgentState.RESEARCHING, step.id);
		const [session, steps, decisions, guidance] = await Promise.all([
			this.prisma.session.findUniqueOrThrow({ where: { id: sessionId } }),
			this.prisma.planStep.findMany({
				where: { sessionId, status: { not: 'SKIPPED' } },
				orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
			}),
			this.context.activeDecisions(sessionId),
			this.context.guidance(sessionId),
		]);
		const sources: ResearchResult['sources'] = [];
		const { text } = await this.llm.generate({
			sessionId,
			purpose: 'research',
			system: AGENT_SYSTEM,
			prompt: researchPrompt({
				goal: session.goal,
				steps,
				step,
				decisions,
				guidance,
			}),
			tools: this.tools(run, step),
			abortSignal: run.signal,
		});
		return { notes: text, sources };
	}

	private async webSearch(
		sessionId: string,
		step: PlanStep,
		query: string,
	): Promise<string> {
		await this.agentState.set(sessionId, AgentState.RESEARCHING, step.id);
		try {
			const results = await this.search.search(query, { limit: 8 });
			await this.recordCall(sessionId, {
				tool: 'web_search',
				query,
				resultCount: results.length,
				results: results
					.slice(0, 5)
					.map((r) => ({ title: r.title, url: r.url })),
				stepId: step.id,
			});
			if (results.length === 0) return 'No results. Try a different query.';
			return results
				.map((r) => `- ${r.title} — ${r.url}\n  ${r.snippet}`)
				.join('\n');
		} catch (err) {
			const why = errorText(err);
			this.logger.warn(`web_search failed for "${query}": ${why}`);
			await this.recordCall(sessionId, {
				tool: 'web_search',
				query,
				resultCount: 0,
				error: why,
				stepId: step.id,
			});
			return `Search failed (${why}). Continue with what you know, and say which facts you couldn't verify.`;
		}
	}

	private recordCall(sessionId: string, payload: Record<string, unknown>) {
		return this.timeline
			.record(sessionId, {
				type: EventType.TOOL_CALL,
				actorType: ActorType.AGENT,
				payload: payload as never,
			})
			.catch((err) => this.logger.error('Couldn’t record a tool call', err));
	}
}
