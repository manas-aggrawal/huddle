import type { LlmCallOptions, LlmService } from '@src/llm/llm.service';
import type { z } from 'zod';

/** The model's reply wasn't the JSON we asked for, even after a retry. */
export class InvalidModelOutputError extends Error {
	constructor(readonly reason: string) {
		super(`The model's reply wasn't valid: ${reason}`);
		this.name = 'InvalidModelOutputError';
	}
}

/** Pulls the JSON out of a reply that may wrap it in prose or a ``` fence. */
export function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (fenced?.[1] ?? text).trim();
	const start = body.search(/[[{]/);
	if (start === -1) throw new Error('no JSON found');
	const open = body[start];
	const close = open === '{' ? '}' : ']';
	const end = body.lastIndexOf(close);
	if (end <= start) throw new Error('unterminated JSON');
	return JSON.parse(body.slice(start, end + 1));
}

/**
 * Asks for JSON matching `schema`. Works with any model (no provider JSON
 * mode needed): the prompt asks for JSON, the reply is parsed and validated,
 * and one bad reply gets a retry that says what was wrong.
 */
export async function generateJson<S extends z.ZodType>(
	llm: LlmService,
	options: Omit<LlmCallOptions, 'prompt'> & { prompt: string },
	schema: S,
): Promise<z.infer<S>> {
	let prompt = options.prompt;
	let reason = '';
	for (let attempt = 0; attempt < 2; attempt++) {
		const { text } = await llm.generate({ ...options, prompt });
		try {
			const parsed = schema.safeParse(extractJson(text));
			if (parsed.success) return parsed.data;
			reason = parsed.error.issues
				.slice(0, 3)
				.map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`)
				.join('; ');
		} catch (err) {
			reason = (err as Error).message;
		}
		prompt = `${options.prompt}\n\nYour previous reply was invalid (${reason}). Reply with only the JSON, nothing else.`;
	}
	throw new InvalidModelOutputError(reason);
}
