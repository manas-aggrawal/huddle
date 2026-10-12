import {
	ActorType,
	ApprovalKind,
	ApprovalStatus,
	EventType,
} from '@huddle/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PlanStep, Prisma } from '@prisma/client';
import { ApprovalService } from '@src/approval/approval.service';
import {
	AgentDocWriter,
	HumanTextProtectedError,
	TextNotFoundError,
} from '@src/collab/agent-doc-writer.service';
import { PrismaService } from '@src/prisma/prisma.service';
import { TimelineService } from '@src/timeline/timeline.service';

export interface RewriteDetails {
	sectionId: string;
	sectionTitle: string;
	before: string;
	after: string;
	/** Whose text it is, for the card. */
	authors: string[];
}

/**
 * Changes to text that's already in the doc. The agent's own text is changed
 * directly; text a person wrote needs a REWRITE_HUMAN_TEXT approval first,
 * showing before and after.
 */
@Injectable()
export class RewriteService {
	private readonly logger = new Logger(RewriteService.name);

	constructor(
		private readonly prisma: PrismaService,
		private readonly timeline: TimelineService,
		private readonly doc: AgentDocWriter,
		private readonly approvals: ApprovalService,
	) {}

	/**
	 * Tries the change; if it touches human text, asks for approval instead.
	 * Returns what happened, for the agent's reply.
	 */
	async propose(
		sessionId: string,
		step: PlanStep,
		before: string,
		after: string,
	): Promise<'applied' | 'asked' | 'not_found'> {
		if (!step.sectionId) return 'not_found';
		try {
			await this.doc.replaceText(sessionId, step.sectionId, before, after);
			return 'applied';
		} catch (err) {
			if (err instanceof TextNotFoundError) return 'not_found';
			if (!(err instanceof HumanTextProtectedError)) throw err;
			const authorIds = [...new Set(err.ranges.map((r) => r.userId))];
			const users = await this.prisma.user.findMany({
				where: { id: { in: authorIds } },
				select: { firstname: true, lastname: true },
			});
			const details: RewriteDetails = {
				sectionId: step.sectionId,
				sectionTitle: step.title,
				before,
				after,
				authors: users.map((u) => `${u.firstname} ${u.lastname}`.trim()),
			};
			await this.timeline.transaction((tx) =>
				this.approvals.request(tx, sessionId, {
					kind: ApprovalKind.REWRITE_HUMAN_TEXT,
					title: `Rewrite text in “${step.title}”?`,
					details: details as unknown as Prisma.InputJsonValue,
					planStepId: step.id,
				}),
			);
			return 'asked';
		}
	}

	/** Applies an approved rewrite. If the text changed since, says so instead. */
	async applyApproved(approvalId: string) {
		const approval = await this.prisma.approval.findUnique({
			where: { id: approvalId },
		});
		if (
			!approval ||
			approval.kind !== ApprovalKind.REWRITE_HUMAN_TEXT ||
			approval.status !== ApprovalStatus.APPROVED
		) {
			return;
		}
		const d = approval.details as unknown as RewriteDetails;
		try {
			await this.doc.replaceText(
				approval.sessionId,
				d.sectionId,
				d.before,
				d.after,
				{
					allowHuman: true,
				},
			);
		} catch (err) {
			if (!(err instanceof TextNotFoundError)) {
				this.logger.error(`Couldn't apply rewrite ${approvalId}`, err);
			}
			await this.timeline.record(approval.sessionId, {
				type: EventType.AGENT_MESSAGE,
				actorType: ActorType.AGENT,
				payload: {
					text: `I couldn’t apply the approved rewrite in “${d.sectionTitle}”: the text changed in the meantime.`,
					kind: 'error',
				},
			});
		}
	}
}
