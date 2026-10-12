import {
	AgentState,
	ApprovalKind,
	Effort,
	SessionRole,
	SessionStatus,
	StepStatus,
} from '@huddle/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SessionSchema = z.object({
	id: z.uuid(),
	workspaceId: z.uuid(),
	title: z.string(),
	goal: z.string(),
	status: z.enum(SessionStatus),
	agentState: z.enum(AgentState),
	modelProvider: z.string(),
	modelId: z.string(),
	effort: z.enum(Effort),
	tokenBudget: z.number().int().nullable(),
	tokensUsed: z.number().int(),
	lastEventSeq: z
		.number()
		.int()
		.describe('Number of the newest timeline event'),
	createdAt: z.string(),
	updatedAt: z.string().describe('Last activity'),
	// iso.datetime, not string: nestjs-zod turns a top-level nullable z.string() into an array in OpenAPI.
	completedAt: z.iso.datetime().nullable(),
});
export class SessionDto extends createZodDto(SessionSchema) {}

export const SessionListItemSchema = SessionSchema.extend({
	myRole: z.enum(SessionRole),
	memberCount: z.number().int(),
});
export class SessionListItemDto extends createZodDto(SessionListItemSchema) {}

export const MemberSchema = z.object({
	userId: z.uuid(),
	username: z.string(),
	firstname: z.string(),
	lastname: z.string(),
	role: z.enum(SessionRole),
	canApprove: z.boolean(),
	joinedAt: z.string(),
});

export class MemberDto extends createZodDto(MemberSchema) {}

export const PlanStepSchema = z.object({
	id: z.uuid(),
	position: z.number().int(),
	title: z.string(),
	// The max keeps OpenAPI from misreading string|null as an array when this is a top-level response.
	description: z.string().max(1000).nullable(),
	status: z.enum(StepStatus),
	sectionId: z.string().max(64).nullable(),
	requiresApproval: z.boolean(),
});

export class PlanStepDto extends createZodDto(PlanStepSchema) {}

const PendingApprovalSchema = z.object({
	id: z.uuid(),
	kind: z.enum(ApprovalKind),
	title: z.string(),
	details: z.unknown().nullable(),
	planStepId: z.uuid().nullable(),
	requestedAt: z.string(),
});

export const DecisionSchema = z.object({
	id: z.uuid(),
	content: z.string(),
	/** Where it came from: typed by hand, an answered approval, or a settled conflict. */
	origin: z.enum(['manual', 'approval', 'conflict']),
	createdBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
	pinnedAt: z.string(),
});
export class DecisionDto extends createZodDto(DecisionSchema) {}

const OpenConflictSchema = z.object({
	id: z.uuid(),
	summary: z.string(),
	planStepId: z.uuid().nullable(),
	createdAt: z.string(),
});

export const SessionDetailSchema = SessionSchema.extend({
	myRole: z.enum(SessionRole),
	myCanApprove: z.boolean(),
	members: z.array(MemberSchema),
	planSteps: z.array(PlanStepSchema),
	pendingApprovals: z.array(PendingApprovalSchema),
	/** Pinned decisions still in force, oldest first. */
	decisions: z.array(DecisionSchema),
	/** Conflicts waiting for the Owner. */
	openConflicts: z.array(OpenConflictSchema),
	/** The workspace's shared token pool, for the budget meter. */
	workspaceUsage: z.object({
		tokenAllowance: z.number().int(),
		tokensUsedThisPeriod: z.number().int(),
	}),
	/** The latest handoff, with its briefing (the new Owner sees it as a card). */
	lastHandoff: z
		.object({
			id: z.uuid(),
			from: z.object({ id: z.uuid(), name: z.string() }),
			to: z.object({ id: z.uuid(), name: z.string() }),
			briefing: z.string(),
			note: z.string().max(2000).nullable(),
			createdAt: z.string(),
		})
		.nullable(),
});
export class SessionDetailDto extends createZodDto(SessionDetailSchema) {}
