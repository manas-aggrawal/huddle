import { MockLanguageModelV4 } from 'ai/test';

type DoGenerate = MockLanguageModelV4['doGenerate'];
type DoStream = MockLanguageModelV4['doStream'];
type CallOptions = Parameters<DoGenerate>[0];
type GenerateResult = Awaited<ReturnType<DoGenerate>>;
type StreamPart = Awaited<
	ReturnType<DoStream>
>['stream'] extends ReadableStream<infer P>
	? P
	: never;

/** One model call's scripted response. Each call to the model consumes the next step. */
export interface ScriptedStep {
	/**
	 * Text the model "writes". Streamed word by word in streaming calls. A
	 * function gets the call's prompt as text, for replies that must echo ids.
	 */
	text?: string | ((prompt: string) => string);
	/** Tool calls the model makes; `input` is serialized to JSON for you. */
	toolCalls?: { toolName: string; input: unknown }[];
	/** Token usage to report. Defaults: 10 input, one output token per word. */
	usage?: { input: number; output: number };
	/** Delay between streamed chunks, to give tests time to interrupt mid-stream. */
	chunkDelayMs?: number;
	/** Make this call fail, e.g. to test retries and error handling. */
	error?: Error;
}

export interface ScriptedModel {
	model: MockLanguageModelV4;
	/** Every call the model received, in order (generate and stream combined). */
	calls: CallOptions[];
	/** All prompt text of call `i`, flattened, for asserting what context the agent sent. */
	promptText(i: number): string;
	/** How many scripted steps are still unused. */
	remaining(): number;
}

/**
 * A deterministic stand-in for a real LLM. Tests script exactly what the model
 * says, so agent behavior can be asserted without network calls or cost.
 */
export function scriptedModel(steps: ScriptedStep[]): ScriptedModel {
	const calls: CallOptions[] = [];
	let next = 0;

	function take(options: CallOptions): ScriptedStep & { text?: string } {
		calls.push(options);
		const step = steps[next++];
		if (!step) {
			throw new Error(
				`Mock model ran out of scripted steps (call #${next}). Add another ScriptedStep.`,
			);
		}
		if (step.error) throw step.error;
		const text =
			typeof step.text === 'function'
				? step.text(JSON.stringify(options.prompt))
				: step.text;
		return { ...step, text };
	}

	function usageOf(
		step: ScriptedStep & { text?: string },
	): GenerateResult['usage'] {
		const words = step.text ? step.text.split(/\s+/).filter(Boolean).length : 0;
		const input = step.usage?.input ?? 10;
		const output = step.usage?.output ?? words;
		return {
			inputTokens: {
				total: input,
				noCache: input,
				cacheRead: 0,
				cacheWrite: 0,
			},
			outputTokens: { total: output, text: output, reasoning: 0 },
		};
	}

	function finishOf(step: ScriptedStep): GenerateResult['finishReason'] {
		return step.toolCalls?.length
			? { unified: 'tool-calls', raw: 'tool_calls' }
			: { unified: 'stop', raw: 'stop' };
	}

	function toolCallParts(step: ScriptedStep) {
		return (step.toolCalls ?? []).map((call, i) => ({
			type: 'tool-call' as const,
			toolCallId: `call_${next}_${i}`,
			toolName: call.toolName,
			input: JSON.stringify(call.input),
		}));
	}

	const doGenerate: DoGenerate = async (options) => {
		const step = take(options);
		return {
			content: [
				...(step.text ? [{ type: 'text' as const, text: step.text }] : []),
				...toolCallParts(step),
			],
			finishReason: finishOf(step),
			usage: usageOf(step),
			warnings: [],
		};
	};

	const doStream: DoStream = async (options) => {
		const step = take(options);
		const chunks = step.text ? (step.text.match(/\S+\s*/g) ?? []) : [];
		const signal = options.abortSignal;

		const stream = new ReadableStream<StreamPart>({
			async start(controller) {
				controller.enqueue({ type: 'stream-start', warnings: [] });
				if (chunks.length) {
					controller.enqueue({ type: 'text-start', id: 't0' });
					for (const delta of chunks) {
						if (signal?.aborted) {
							controller.error(signal.reason ?? new Error('Aborted'));
							return;
						}
						controller.enqueue({ type: 'text-delta', id: 't0', delta });
						if (step.chunkDelayMs) {
							await new Promise((r) => setTimeout(r, step.chunkDelayMs));
						}
					}
					controller.enqueue({ type: 'text-end', id: 't0' });
				}
				for (const part of toolCallParts(step)) controller.enqueue(part);
				controller.enqueue({
					type: 'finish',
					finishReason: finishOf(step),
					usage: usageOf(step),
				});
				controller.close();
			},
		});
		return { stream };
	};

	return {
		model: new MockLanguageModelV4({ doGenerate, doStream }),
		calls,
		promptText(i) {
			const call = calls[i];
			if (!call) throw new Error(`No model call #${i}`);
			return JSON.stringify(call.prompt);
		},
		remaining: () => steps.length - next,
	};
}
