import { AGENT_OPTIONS, type AgentOptions } from '@src/agent/agent.options';
import { LLM_PROVIDER_OVERRIDE, type ModelFactory } from '@src/llm/providers';
import {
	type ScriptedModel,
	type ScriptedStep,
	scriptedModel,
} from './mock-llm';

/**
 * A swappable scripted model for suites where the agent runs. `script()` sets
 * what the next calls return; `overrides` turns the agent on with the mock.
 */
export function agentHarness(options: Partial<AgentOptions> = {}) {
	let current: ScriptedModel = scriptedModel([]);
	const factory: ModelFactory = () => current.model;
	return {
		overrides: [
			{ provide: LLM_PROVIDER_OVERRIDE, useValue: factory },
			{
				provide: AGENT_OPTIONS,
				useValue: {
					enabled: true,
					flushMs: 10,
					...options,
				} satisfies AgentOptions,
			},
		],
		script(steps: ScriptedStep[]): ScriptedModel {
			current = scriptedModel(steps);
			return current;
		},
		get model(): ScriptedModel {
			return current;
		},
	};
}

/** The JSON reply the planner expects, for scripting outlines. */
export const outlineReply = (...titles: string[]) =>
	JSON.stringify({
		steps: titles.map((title) => ({ title, description: `About ${title}` })),
	});

/** Polls until `check` returns a truthy value (which it returns), or fails after `timeoutMs`. */
export async function waitFor<T>(
	check: () =>
		| Promise<T | null | undefined | false>
		| T
		| null
		| undefined
		| false,
	{ timeoutMs = 5000, what = 'condition' } = {},
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try {
			const value = await check();
			if (value) return value;
		} catch (err) {
			last = err;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`,
			);
		}
		await new Promise((r) => setTimeout(r, 20));
	}
}
