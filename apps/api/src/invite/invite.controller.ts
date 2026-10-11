import { Controller, Get, Param, Post, Request } from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiGoneResponse,
	ApiNotFoundResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { IsPublic } from '@src/auth/decorators/is-public';
import { ZodResponse } from 'nestjs-zod';
import { AcceptInviteDto, InvitePreviewDto } from './dto/invite.response';
import { InviteService } from './invite.service';

/** What happens when someone opens a link. */
@ApiTags('Invites')
@Controller('invites')
export class InviteController {
	constructor(private readonly invites: InviteService) {}

	/** Shows what the link is for. Works without logging in. */
	@IsPublic()
	@Get(':token')
	@ApiOperation({ summary: 'Preview an invite link' })
	@ApiNotFoundResponse({ description: 'No such link' })
	@ApiGoneResponse({ description: 'The link was revoked or has expired' })
	@ZodResponse({ status: 200, type: InvitePreviewDto })
	preview(@Param('token') token: string): Promise<InvitePreviewDto> {
		return this.invites.preview(token);
	}

	/** Joins the session, or raises your role if the link is better than it. Never lowers it. */
	@Post(':token/accept')
	@ApiBearerAuth('access-token')
	@ApiOperation({ summary: 'Accept an invite link' })
	@ApiNotFoundResponse({ description: 'No such link' })
	@ApiGoneResponse({ description: 'The link was revoked or has expired' })
	@ZodResponse({ status: 200, type: AcceptInviteDto })
	accept(
		@Request() req,
		@Param('token') token: string,
	): Promise<AcceptInviteDto> {
		return this.invites.accept(req.user.id, token);
	}
}
