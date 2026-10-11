import { SessionRole } from '@huddle/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const PersonSchema = z.object({ id: z.uuid(), name: z.string() });

export const InviteSchema = z.object({
	id: z.uuid(),
	role: z.enum(SessionRole),
	createdBy: PersonSchema,
	useCount: z.number().int(),
	// iso.datetime, not string: nestjs-zod turns a top-level nullable z.string() into an array in OpenAPI.
	expiresAt: z.iso.datetime().nullable(),
	createdAt: z.string(),
});
export class InviteDto extends createZodDto(InviteSchema) {}

export const CreatedInviteSchema = InviteSchema.extend({
	token: z.string().describe('Shown only now. Only its hash is stored.'),
	url: z.string().describe('The link to share'),
});
export class CreatedInviteDto extends createZodDto(CreatedInviteSchema) {}

export const InvitePreviewSchema = z.object({
	sessionId: z.uuid(),
	sessionTitle: z.string(),
	invitedBy: z.string(),
	role: z.enum(SessionRole),
	// iso.datetime, not string: nestjs-zod turns a top-level nullable z.string() into an array in OpenAPI.
	expiresAt: z.iso.datetime().nullable(),
});
export class InvitePreviewDto extends createZodDto(InvitePreviewSchema) {}

export const AcceptInviteSchema = z.object({
	sessionId: z.uuid(),
	role: z.enum(SessionRole).describe('Your role in the session now'),
	joined: z.boolean().describe('True if you just became a member'),
	upgraded: z
		.boolean()
		.describe('True if your existing role was raised by this link'),
});
export class AcceptInviteDto extends createZodDto(AcceptInviteSchema) {}
