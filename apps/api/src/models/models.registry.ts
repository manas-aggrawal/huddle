import {
	DEFAULT_MODEL_ID,
	DEFAULT_MODEL_PROVIDER,
	MODELS,
} from '@src/configs/env-vars';

export interface ModelOption {
	provider: string;
	modelId: string;
	/** "groq · llama-3.3-70b-versatile" */
	label: string;
	isDefault: boolean;
}

/** "ollama:qwen2.5:14b" → provider "ollama", model "qwen2.5:14b" (the id itself may contain ":"). */
function parse(entry: string): { provider: string; modelId: string } | null {
	const i = entry.indexOf(':');
	if (i <= 0 || i === entry.length - 1) return null;
	return {
		provider: entry.slice(0, i).trim(),
		modelId: entry.slice(i + 1).trim(),
	};
}

/**
 * The models sessions may use, from MODELS, with the default first. The LLM
 * layer (T12) builds its providers from this same list.
 */
export function allowedModels(): ModelOption[] {
	const entries = [
		{ provider: DEFAULT_MODEL_PROVIDER, modelId: DEFAULT_MODEL_ID },
		...(MODELS ?? '')
			.split(',')
			.map((e) => parse(e.trim()))
			.filter((m): m is { provider: string; modelId: string } => m !== null),
	];
	const seen = new Set<string>();
	return entries
		.filter((m) => {
			const key = `${m.provider}:${m.modelId}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((m, i) => ({
			...m,
			label: `${m.provider} · ${m.modelId}`,
			isDefault: i === 0,
		}));
}

export function isAllowedModel(provider: string, modelId: string): boolean {
	return allowedModels().some(
		(m) => m.provider === provider && m.modelId === modelId,
	);
}
