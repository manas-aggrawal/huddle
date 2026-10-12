import { Effort } from '@huddle/shared';

export interface EffortSettings {
	maxOutputTokens: number;
	temperature: number;
	/** Most model calls one request may make while using tools. */
	maxSteps: number;
}

/** What each effort level means for a call. More effort: longer answers, more tool use. */
export const EFFORT_SETTINGS: Record<Effort, EffortSettings> = {
	[Effort.LOW]: { maxOutputTokens: 1024, temperature: 0.3, maxSteps: 3 },
	[Effort.MEDIUM]: { maxOutputTokens: 2048, temperature: 0.5, maxSteps: 6 },
	[Effort.HIGH]: { maxOutputTokens: 4096, temperature: 0.7, maxSteps: 12 },
};

export function effortSettings(effort: string): EffortSettings {
	return EFFORT_SETTINGS[effort as Effort] ?? EFFORT_SETTINGS[Effort.MEDIUM];
}
