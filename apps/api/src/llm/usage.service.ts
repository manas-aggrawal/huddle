import { Injectable } from '@nestjs/common';
import { PrismaService } from '@src/prisma/prisma.service';
import { BudgetExceededError, PoolExhaustedError } from './errors';

export interface UsageEntry {
	sessionId: string;
	provider: string;
	model: string;
	purpose: string;
	inputTokens: number;
	outputTokens: number;
}

/** A session's model settings, as read by the budget check before a call. */
export interface SessionModelSettings {
	workspaceId: string;
	modelProvider: string;
	modelId: string;
	effort: string;
}

/** A billing period lasts one calendar month from periodStart. */
function periodCutoff(now = new Date()): Date {
	const d = new Date(now);
	d.setMonth(d.getMonth() - 1);
	return d;
}

/**
 * The token pool and per-session cap. Checked before each model call and
 * updated after it. The check isn't locked against concurrent calls, so a call
 * already in flight can overshoot a limit slightly; the next one is refused.
 */
@Injectable()
export class UsageService {
	constructor(private readonly prisma: PrismaService) {}

	/**
	 * Starts a new period if the workspace's is over a month old, then refuses
	 * the call if the workspace pool or the session cap is used up.
	 */
	async checkBudget(sessionId: string): Promise<SessionModelSettings> {
		const session = await this.prisma.session.findUniqueOrThrow({
			where: { id: sessionId },
			select: {
				workspaceId: true,
				modelProvider: true,
				modelId: true,
				effort: true,
				tokenBudget: true,
				tokensUsed: true,
			},
		});

		// Conditional, so two calls racing at the period boundary reset it once.
		await this.prisma.workspace.updateMany({
			where: { id: session.workspaceId, periodStart: { lte: periodCutoff() } },
			data: { tokensUsedThisPeriod: 0, periodStart: new Date() },
		});
		const workspace = await this.prisma.workspace.findUniqueOrThrow({
			where: { id: session.workspaceId },
			select: { tokenAllowance: true, tokensUsedThisPeriod: true },
		});

		if (workspace.tokensUsedThisPeriod >= workspace.tokenAllowance) {
			throw new PoolExhaustedError(
				session.workspaceId,
				workspace.tokenAllowance,
				workspace.tokensUsedThisPeriod,
			);
		}
		if (
			session.tokenBudget !== null &&
			session.tokensUsed >= session.tokenBudget
		) {
			throw new BudgetExceededError(
				sessionId,
				session.tokenBudget,
				session.tokensUsed,
			);
		}
		return {
			workspaceId: session.workspaceId,
			modelProvider: session.modelProvider,
			modelId: session.modelId,
			effort: session.effort,
		};
	}

	/** Writes the UsageRecord and adds its tokens to the session and workspace totals, together. */
	async record(entry: UsageEntry): Promise<void> {
		const total = entry.inputTokens + entry.outputTokens;
		await this.prisma.$transaction(async (tx) => {
			await tx.usageRecord.create({ data: entry });
			const session = await tx.session.update({
				where: { id: entry.sessionId },
				data: { tokensUsed: { increment: total } },
				select: { workspaceId: true },
			});
			await tx.workspace.update({
				where: { id: session.workspaceId },
				data: { tokensUsedThisPeriod: { increment: total } },
			});
		});
	}
}
