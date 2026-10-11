import { SessionRole } from '@huddle/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const UpdateMemberSchema = z
	.object({
		role: z
			.enum([SessionRole.EDITOR, SessionRole.VIEWER])
			.optional()
			.describe(
				'OWNER is not allowed here: ownership changes only through handoff',
			),
		canApprove: z
			.boolean()
			.optional()
			.describe(
				'Editors only. Switched off automatically when someone becomes a Viewer.',
			),
	})
	.refine((v) => v.role !== undefined || v.canApprove !== undefined, {
		message: 'Send a role, canApprove, or both',
	});
export class UpdateMemberDto extends createZodDto(UpdateMemberSchema) {}
