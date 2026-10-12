import { ApprovalKind, ApprovalStatus } from '@huddle/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ApprovalDecision = {
	APPROVE: 'approve',
	REJECT: 'reject',
} as const;

const ResolveApprovalSchema = z.object({
	decision: z.enum(ApprovalDecision),
	note: z
		.string()
		.trim()
		.min(1)
		.max(2000)
		.optional()
		.describe(
			'Why. A note on a rejected outline tells the agent what to change.',
		),
});
export class ResolveApprovalDto extends createZodDto(ResolveApprovalSchema) {}

const ApprovalSchema = z.object({
	id: z.uuid(),
	sessionId: z.uuid(),
	kind: z.enum(ApprovalKind),
	title: z.string(),
	details: z.unknown().nullable(),
	planStepId: z.uuid().nullable(),
	status: z.enum(ApprovalStatus),
	requestedAt: z.string(),
	resolvedById: z.uuid().nullable(),
	resolvedAt: z.iso.datetime().nullable(),
	// The max keeps OpenAPI from merging string|null into one `type` list,
	// which Nest's Swagger module then misreads as an array.
	note: z.string().max(2000).nullable(),
});
export class ApprovalDto extends createZodDto(ApprovalSchema) {}
