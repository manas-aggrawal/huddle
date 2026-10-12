import { ApprovalKind } from '@huddle/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const CatchUpSchema = z.object({
	/** You'd seen everything up to here. */
	fromSeq: z.number().int(),
	/** The newest event. */
	toSeq: z.number().int(),
	unseenCount: z.number().int(),
	stepsCompleted: z.array(
		z.object({ stepId: z.string(), title: z.string(), seq: z.number().int() }),
	),
	decisions: z.array(
		z.object({
			decisionId: z.string(),
			content: z.string(),
			by: z.string().max(200).nullable(),
			seq: z.number().int(),
		}),
	),
	waitingOnYou: z.array(
		z.object({
			kind: z.enum(['approval', 'conflict']),
			id: z.string(),
			title: z.string(),
			approvalKind: z.enum(ApprovalKind).nullable(),
			seq: z.number().int().nullable(),
		}),
	),
	// The max keeps OpenAPI from misreading string|null as an array (see approval.dto.ts).
	summary: z
		.string()
		.max(4000)
		.nullable()
		.describe('Short LLM summary; null when there was too little to summarize'),
});
export class CatchUpDto extends createZodDto(CatchUpSchema) {}

export class SeenDto extends createZodDto(
	z.object({ seq: z.number().int().min(0) }),
) {}

export class SeenResultDto extends createZodDto(
	z.object({ lastSeenSeq: z.number().int() }),
) {}
