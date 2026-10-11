import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Post,
} from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiNoContentResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { SessionMember } from '@prisma/client';
import {
	CurrentMembership,
	RequireSessionAction,
} from '@src/session/decorators/session-access.decorator';
import { ZodResponse } from 'nestjs-zod';
import { CreateInviteDto } from './dto/invite.request';
import { CreatedInviteDto, InviteDto } from './dto/invite.response';
import { InviteService } from './invite.service';

/** Invite and share links for one session. Owner only. */
@ApiTags('Invites')
@ApiBearerAuth('access-token')
@Controller('sessions/:id/invites')
export class SessionInvitesController {
	constructor(private readonly invites: InviteService) {}

	/** Creates a link. The URL in the response is shown only once; keep it to share it. */
	@Post()
	@RequireSessionAction('invite')
	@ApiOperation({ summary: 'Create an invite (EDITOR) or share (VIEWER) link' })
	@ZodResponse({ status: 201, type: CreatedInviteDto })
	create(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
		@Body() body: CreateInviteDto,
	): Promise<CreatedInviteDto> {
		return this.invites.create(membership, body);
	}

	/** Links that still work. Tokens aren't included; they're never stored. */
	@Get()
	@RequireSessionAction('invite')
	@ApiOperation({ summary: 'List active links' })
	@ZodResponse({ status: 200, type: [InviteDto] })
	list(@Param('id') sessionId: string): Promise<InviteDto[]> {
		return this.invites.listActive(sessionId);
	}

	@Delete(':inviteId')
	@HttpCode(204)
	@RequireSessionAction('invite')
	@ApiOperation({ summary: 'Revoke a link' })
	@ApiNoContentResponse({ description: 'The link no longer works' })
	revoke(
		@Param('id') sessionId: string,
		@Param('inviteId') inviteId: string,
	): Promise<void> {
		return this.invites.revoke(sessionId, inviteId);
	}
}
