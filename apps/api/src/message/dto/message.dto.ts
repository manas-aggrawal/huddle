import { MessageLimits, MessageMode, MessageStatus } from '@huddle/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const AnchorSchema = z
	.object({
		sectionId: z.string().min(1).max(64),
		quote: z.string().min(1).max(1000),
		/** Yjs relative positions, base64, so the highlight survives edits. */
		from: z.string().max(500).optional(),
		to: z.string().max(500).optional(),
	})
	.describe('For comments: the section and quoted text it refers to');

const CreateMessageSchema = z.object({
	mode: z.enum(MessageMode),
	content: z
		.string()
		.trim()
		.min(1, 'Write something first')
		.max(MessageLimits.CONTENT_MAX)
		.describe('Mention people as @[userId]'),
	planStepId: z.uuid().optional(),
	anchor: AnchorSchema.optional(),
});
export class CreateMessageDto extends createZodDto(CreateMessageSchema) {}

const MessageSchema = z.object({
	id: z.uuid(),
	sessionId: z.uuid(),
	authorId: z.uuid(),
	mode: z.enum(MessageMode),
	content: z.string(),
	anchor: z.unknown().nullable(),
	planStepId: z.uuid().nullable(),
	status: z.enum(MessageStatus),
	// The max keeps OpenAPI from misreading string|null as an array (see approval.dto.ts).
	response: z.string().max(100_000).nullable(),
	createdAt: z.string(),
});
export class MessageDto extends createZodDto(MessageSchema) {}

export class ListMessagesQueryDto extends createZodDto(
	z.object({ mode: z.enum(MessageMode).optional() }),
) {}

const MessageWithAuthorSchema = MessageSchema.extend({
	author: z.object({ id: z.uuid(), name: z.string() }),
});
export class MessageWithAuthorDto extends createZodDto(
	MessageWithAuthorSchema,
) {}
