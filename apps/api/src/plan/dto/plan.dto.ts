import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(1000);

export class AddStepDto extends createZodDto(
	z.object({
		title,
		description: description.optional(),
		requiresApproval: z.boolean().optional(),
		after: z
			.uuid()
			.nullable()
			.optional()
			.describe(
				'Put it after this step. null puts it first; omitted puts it last.',
			),
	}),
) {}

export class UpdateStepDto extends createZodDto(
	z
		.object({
			title: title.optional(),
			description: description.nullable().optional(),
			requiresApproval: z.boolean().optional(),
			/** Skip a step, or bring a skipped one back. */
			skipped: z.boolean().optional(),
		})
		.refine((v) => Object.values(v).some((x) => x !== undefined), {
			message: 'Nothing to change',
		}),
) {}

export class ReorderStepsDto extends createZodDto(
	z.object({
		orderedIds: z
			.array(z.uuid())
			.min(1)
			.describe('Every step id in the new order'),
	}),
) {}
