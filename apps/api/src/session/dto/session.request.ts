import { Effort, SessionStatus } from '@huddle/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Value sets come from @huddle/shared. There are no database enums, so these
// checks are what keep invalid values out of the database.

const CreateSessionSchema = z.object({
	workspaceId: z
		.uuid()
		.optional()
		.describe(
			'Workspace to create the session in. Defaults to your personal workspace.',
		),
	title: z.string().trim().min(1).max(200),
	goal: z.string().trim().min(1).max(5000).describe('What the team wants done'),
	modelProvider: z.string().trim().min(1).max(50).optional(),
	modelId: z.string().trim().min(1).max(100).optional(),
	effort: z.enum(Effort).optional(),
	tokenBudget: z
		.number()
		.int()
		.positive()
		.nullable()
		.optional()
		.describe('Optional cap for this session. Null or omitted means no cap.'),
});
export class CreateSessionDto extends createZodDto(CreateSessionSchema) {}

const ListSessionsQuerySchema = z.object({
	status: z.enum(SessionStatus).optional(),
});
export class ListSessionsQueryDto extends createZodDto(
	ListSessionsQuerySchema,
) {}

export const StatusAction = {
	PAUSE: 'pause',
	RESUME: 'resume',
	END: 'end',
} as const;

const UpdateSessionStatusSchema = z.object({
	action: z.enum(StatusAction),
});
export class UpdateSessionStatusDto extends createZodDto(
	UpdateSessionStatusSchema,
) {}
