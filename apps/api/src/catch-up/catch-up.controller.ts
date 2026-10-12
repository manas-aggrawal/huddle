import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SessionMember } from '@prisma/client';
import {
	CurrentMembership,
	RequireSessionAction,
} from '@src/session/decorators/session-access.decorator';
import { ZodResponse } from 'nestjs-zod';
import { CatchUpDto, SeenDto, SeenResultDto } from './catch-up.dto';
import { CatchUpService } from './catch-up.service';

@ApiTags('Sessions')
@ApiBearerAuth('access-token')
@Controller('sessions/:id')
export class CatchUpController {
	constructor(private readonly catchUp: CatchUpService) {}

	/** What happened since you last looked: steps, decisions, what's waiting on you, and a short summary. */
	@Get('catch-up')
	@RequireSessionAction('watch')
	@ApiOperation({ summary: 'Catch up on a session' })
	@ZodResponse({ status: 200, type: CatchUpDto })
	get(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
	): Promise<CatchUpDto> {
		return this.catchUp.get(membership);
	}

	/** You've seen the timeline up to `seq`. Only ever moves forward. */
	@Post('seen')
	@HttpCode(200)
	@RequireSessionAction('watch')
	@ApiOperation({ summary: 'Mark the timeline as seen' })
	@ZodResponse({ status: 200, type: SeenResultDto })
	async seen(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
		@Body() body: SeenDto,
	): Promise<SeenResultDto> {
		return { lastSeenSeq: await this.catchUp.markSeen(membership, body.seq) };
	}
}
