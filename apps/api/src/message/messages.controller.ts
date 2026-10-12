import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiConflictResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { SessionMember } from '@prisma/client';
import {
	CurrentMembership,
	RequireSessionAction,
} from '@src/session/decorators/session-access.decorator';
import { ZodResponse } from 'nestjs-zod';
import {
	CreateMessageDto,
	ListMessagesQueryDto,
	MessageDto,
	MessageWithAuthorDto,
} from './dto/message.dto';
import { MessageService, toMessageDto } from './message.service';

@ApiTags('Messages')
@ApiBearerAuth('access-token')
@Controller('sessions/:id/messages')
export class MessagesController {
	constructor(private readonly messages: MessageService) {}

	/**
	 * Talk to the agent. Suggest and Interrupt need Editor or Owner; anyone can
	 * Ask or Comment. Mention people as @[userId] to notify them.
	 */
	@Post()
	@RequireSessionAction('watch')
	@ApiOperation({ summary: 'Send a message to the agent' })
	@ApiConflictResponse({ description: 'The session is done (Ask still works)' })
	@ZodResponse({ status: 201, type: MessageDto })
	async create(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
		@Body() body: CreateMessageDto,
	): Promise<MessageDto> {
		return toMessageDto(await this.messages.create(membership, body));
	}

	/** Messages in the session, oldest first; `?mode=COMMENT` lists the doc's comments. */
	@Get()
	@RequireSessionAction('watch')
	@ApiOperation({ summary: 'List messages' })
	@ZodResponse({ status: 200, type: [MessageWithAuthorDto] })
	list(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
		@Query() query: ListMessagesQueryDto,
	): Promise<MessageWithAuthorDto[]> {
		return this.messages.list(membership.sessionId, query.mode);
	}
}
