import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { GROQ_API_KEY, OLLAMA_BASE_URL } from '@src/configs/env-vars';
import { isAllowedModel } from '@src/models/models.registry';
import type { LanguageModel } from 'ai';
import { ModelUnavailableError } from './errors';

/** Builds the model for a provider and model id. Tests replace this through LLM_PROVIDER_OVERRIDE. */
export type ModelFactory = (
	provider: string,
	modelId: string,
) => Exclude<LanguageModel, string>;

/**
 * Inject a ModelFactory here to bypass real providers (tests use the scripted
 * mock). `null` means use the real providers.
 */
export const LLM_PROVIDER_OVERRIDE = Symbol('LLM_PROVIDER_OVERRIDE');

let groq: ReturnType<typeof createGroq> | undefined;
let ollama: ReturnType<typeof createOpenAICompatible> | undefined;

/** Real providers. Adding one (e.g. a paid API) only touches this function. */
export const realModelFactory: ModelFactory = (provider, modelId) => {
	if (!isAllowedModel(provider, modelId)) {
		throw new ModelUnavailableError(provider, modelId, 'not in MODELS');
	}
	switch (provider) {
		case 'groq':
			if (!GROQ_API_KEY) {
				throw new ModelUnavailableError(
					provider,
					modelId,
					'GROQ_API_KEY is not set',
				);
			}
			groq ??= createGroq({ apiKey: GROQ_API_KEY });
			return groq(modelId);
		case 'ollama':
			// Ollama serves an OpenAI-compatible API under /v1.
			ollama ??= createOpenAICompatible({
				name: 'ollama',
				baseURL: `${OLLAMA_BASE_URL.replace(/\/+$/, '')}/v1`,
			});
			return ollama(modelId);
		default:
			throw new ModelUnavailableError(provider, modelId, 'unknown provider');
	}
};
