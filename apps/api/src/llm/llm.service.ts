import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
	generateText,
	type LanguageModelMiddleware,
	type ModelMessage,
	stepCountIs,
	streamText,
	type ToolSet,
	wrapLanguageModel,
} from 'ai';
import { effortSettings } from './effort';
import {
	LLM_PROVIDER_OVERRIDE,
	type ModelFactory,
	realModelFactory,
} from './providers';
import { UsageService } from './usage.service';

export interface LlmCallOptions<TOOLS extends ToolSet = ToolSet> {
	sessionId: string;
	/** What the call is for, stored on its UsageRecord (e.g. "outline", "section", "ack"). */
	purpose: string;
	system?: string;
	/** A plain text prompt, or the conversation so far. */
	prompt: string | ModelMessage[];
	tools?: TOOLS;
	abortSignal?: AbortSignal;
	/** Overrides the effort level's limit, for short calls like acks. */
	maxOutputTokens?: number;
}

export interface LlmStream<TOOLS extends ToolSet = ToolSet> {
	result: ReturnType<typeof streamText<TOOLS>>;
	/** Resolves once the stream has ended (finished, failed or aborted) and its usage is saved. */
	usageRecorded: Promise<void>;
}

// TS can't resolve the SDK's tool-context conditional types for a generic
// TOOLS, so the shared settings object is cast once at each call site.
type GenerateArgs<TOOLS extends ToolSet> = Parameters<
	typeof generateText<TOOLS>
>[0];
type StreamArgs<TOOLS extends ToolSet> = Parameters<
	typeof streamText<TOOLS>
>[0];

interface CallContext {
	sessionId: string;
	purpose: string;
	provider: string;
	modelId: string;
}

/** Rough token count for text a provider never reported on (about 4 characters per token). */
const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/**
 * The only way agent code talks to a model. Each call uses the session's
 * model and effort, is refused when the workspace pool or session cap is used
 * up, and records the tokens of every model call it makes (one per step in a
 * tool loop).
 */
@Injectable()
export class LlmService {
	private readonly logger = new Logger(LlmService.name);
	private readonly modelFor: ModelFactory;

	constructor(
		private readonly usage: UsageService,
		@Inject(LLM_PROVIDER_OVERRIDE) override: ModelFactory | null,
	) {
		this.modelFor = override ?? realModelFactory;
	}

	/** Throws PoolExhaustedError or BudgetExceededError without calling the model. */
	async generate<TOOLS extends ToolSet = ToolSet>(
		options: LlmCallOptions<TOOLS>,
	) {
		const pending: Promise<void>[] = [];
		const settings = await this.prepare(options, pending);
		const result = await generateText<TOOLS>(
			settings as unknown as GenerateArgs<TOOLS>,
		);
		await Promise.all(pending);
		return result;
	}

	/** Throws PoolExhaustedError or BudgetExceededError without calling the model. */
	async stream<TOOLS extends ToolSet = ToolSet>(
		options: LlmCallOptions<TOOLS>,
	): Promise<LlmStream<TOOLS>> {
		const pending: Promise<void>[] = [];
		const settings = await this.prepare(options, pending);
		let ended!: () => void;
		const done = new Promise<void>((resolve) => {
			ended = resolve;
		});
		const result = streamText<TOOLS>({
			...(settings as unknown as StreamArgs<TOOLS>),
			onFinish: () => ended(),
			onError: () => ended(),
			onAbort: () => ended(),
		});
		return {
			result,
			usageRecorded: done.then(async () => {
				await Promise.all(pending);
			}),
		};
	}

	private async prepare<TOOLS extends ToolSet>(
		options: LlmCallOptions<TOOLS>,
		pending: Promise<void>[],
	) {
		const session = await this.usage.checkBudget(options.sessionId);
		const effort = effortSettings(session.effort);
		const ctx: CallContext = {
			sessionId: options.sessionId,
			purpose: options.purpose,
			provider: session.modelProvider,
			modelId: session.modelId,
		};
		const model = wrapLanguageModel({
			model: this.modelFor(session.modelProvider, session.modelId),
			middleware: this.meter(ctx, pending),
		});
		return {
			model,
			instructions: options.system,
			prompt: options.prompt,
			tools: options.tools,
			abortSignal: options.abortSignal,
			maxOutputTokens: options.maxOutputTokens ?? effort.maxOutputTokens,
			temperature: effort.temperature,
			stopWhen: stepCountIs(effort.maxSteps),
		};
	}

	/**
	 * Wraps each model call: checks the budget before every call after the
	 * first (tool loops), and records the call's tokens when it ends. A stream
	 * cut off before the provider reports usage is estimated from its text.
	 */
	private meter(
		ctx: CallContext,
		pending: Promise<void>[],
	): LanguageModelMiddleware {
		let calls = 0;
		const save = (inputTokens: number, outputTokens: number) => {
			pending.push(
				this.usage
					.record({
						sessionId: ctx.sessionId,
						provider: ctx.provider,
						model: ctx.modelId,
						purpose: ctx.purpose,
						inputTokens,
						outputTokens,
					})
					.catch((err) =>
						this.logger.error(`Failed to record usage: ${String(err)}`),
					),
			);
		};
		const beforeCall = async () => {
			if (calls++ > 0) await this.usage.checkBudget(ctx.sessionId);
		};

		return {
			wrapGenerate: async ({ doGenerate }) => {
				await beforeCall();
				const result = await doGenerate();
				save(
					result.usage.inputTokens.total ?? 0,
					result.usage.outputTokens.total ?? 0,
				);
				return result;
			},
			wrapStream: async ({ doStream, params }) => {
				await beforeCall();
				const result = await doStream();
				const reader = result.stream.getReader();
				let reported: { input: number; output: number } | undefined;
				let outputChars = 0;
				let settled = false;
				const settle = () => {
					if (settled) return;
					settled = true;
					params.abortSignal?.removeEventListener('abort', settle);
					if (reported) save(reported.input, reported.output);
					else
						save(
							estimateTokens(JSON.stringify(params.prompt).length),
							estimateTokens(outputChars),
						);
				};

				// On abort the SDK stops reading without cancelling, so listen directly.
				params.abortSignal?.addEventListener('abort', settle, { once: true });

				const stream = new ReadableStream<LanguageModelV4StreamPart>({
					async pull(controller) {
						try {
							const { done, value } = await reader.read();
							if (done) {
								settle();
								controller.close();
								return;
							}
							if (
								value.type === 'text-delta' ||
								value.type === 'reasoning-delta' ||
								value.type === 'tool-input-delta'
							) {
								outputChars += value.delta.length;
							} else if (value.type === 'finish') {
								reported = {
									input: value.usage.inputTokens.total ?? 0,
									output: value.usage.outputTokens.total ?? 0,
								};
							}
							controller.enqueue(value);
						} catch (err) {
							settle();
							controller.error(err);
						}
					},
					cancel(reason) {
						settle();
						return reader.cancel(reason);
					},
				});
				return { ...result, stream };
			},
		};
	}
}
