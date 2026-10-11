import { SessionRole } from '@huddle/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const CreateInviteSchema = z.object({
	role: z
		.enum([SessionRole.EDITOR, SessionRole.VIEWER])
		.describe('EDITOR for an invite to help, VIEWER for a share link to watch'),
	expiresInHours: z
		.number()
		.int()
		.min(1)
		.max(24 * 30)
		.optional()
		.describe('Omit for a link that never expires. At most 30 days.'),
});
export class CreateInviteDto extends createZodDto(CreateInviteSchema) {}
