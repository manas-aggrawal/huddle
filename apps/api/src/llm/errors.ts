/** The workspace's shared token pool is used up for this period. T28 turns this into a pause. */
export class PoolExhaustedError extends Error {
	readonly workspaceId: string;
	readonly allowance: number;
	readonly used: number;

	constructor(workspaceId: string, allowance: number, used: number) {
		super(
			`Workspace token pool is used up (${used}/${allowance} tokens this period)`,
		);
		this.name = 'PoolExhaustedError';
		this.workspaceId = workspaceId;
		this.allowance = allowance;
		this.used = used;
	}
}

/** The session reached its own cap. T28 turns this into a BUDGET approval. */
export class BudgetExceededError extends Error {
	readonly sessionId: string;
	readonly budget: number;
	readonly used: number;

	constructor(sessionId: string, budget: number, used: number) {
		super(`Session token budget reached (${used}/${budget} tokens)`);
		this.name = 'BudgetExceededError';
		this.sessionId = sessionId;
		this.budget = budget;
		this.used = used;
	}
}

/** The session points at a model that isn't configured (removed from MODELS, or an unknown provider). */
export class ModelUnavailableError extends Error {
	constructor(provider: string, modelId: string, why: string) {
		super(`Model ${provider}:${modelId} is unavailable: ${why}`);
		this.name = 'ModelUnavailableError';
	}
}
