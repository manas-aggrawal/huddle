import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
	ApiBadRequestResponse,
	ApiBearerAuth,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { SessionMember } from '@prisma/client';
import {
	CurrentMembership,
	RequireSessionAction,
} from '@src/session/decorators/session-access.decorator';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { HandoffService } from './handoff.service';

class PreviewHandoffDto extends createZodDto(
	z.object({ toUserId: z.uuid() }),
) {}
class BriefingDto extends createZodDto(z.object({ briefing: z.string() })) {}
class HandoffDto extends createZodDto(
	z.object({
		toUserId: z.uuid(),
		briefing: z.string().trim().min(1).max(8000),
		note: z.string().trim().max(2000).optional(),
	}),
) {}
class HandoffResultDto extends createZodDto(
	z.object({
		id: z.uuid(),
		fromUserId: z.uuid(),
		toUserId: z.uuid(),
		briefing: z.string(),
		note: z.string().max(2000).nullable(),
		createdAt: z.string(),
	}),
) {}

@ApiTags('Sessions')
@ApiBearerAuth('access-token')
@Controller('sessions/:id/handoff')
export class HandoffController {
	constructor(private readonly handoffs: HandoffService) {}

	/** The agent drafts a briefing for the new Owner. Owner only; nothing changes yet. */
	@Post('preview')
	@HttpCode(200)
	@RequireSessionAction('handOff')
	@ApiOperation({ summary: 'Draft a handoff briefing' })
	@ApiBadRequestResponse({ description: 'Not an Editor of this session' })
	@ZodResponse({ status: 200, type: BriefingDto })
	async preview(
		@Param('id') _id: string,
		@CurrentMembership() owner: SessionMember,
		@Body() body: PreviewHandoffDto,
	): Promise<BriefingDto> {
		return { briefing: await this.handoffs.preview(owner, body.toUserId) };
	}

	/** Hands the session to an Editor: they become Owner, you become an Editor who can approve. */
	@Post()
	@RequireSessionAction('handOff')
	@ApiOperation({ summary: 'Hand off the session' })
	@ApiBadRequestResponse({ description: 'Not an Editor of this session' })
	@ZodResponse({ status: 201, type: HandoffResultDto })
	async handOff(
		@Param('id') _id: string,
		@CurrentMembership() owner: SessionMember,
		@Body() body: HandoffDto,
	): Promise<HandoffResultDto> {
		const h = await this.handoffs.handOff(owner, body);
		return {
			id: h.id,
			fromUserId: h.fromUserId,
			toUserId: h.toUserId,
			briefing: h.briefing,
			note: h.note,
			createdAt: h.createdAt.toISOString(),
		};
	}
}
