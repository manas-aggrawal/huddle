import { DecisionLimits } from '@huddle/shared';
import {
	Body,
	Controller,
	Delete,
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
import { DecisionDto } from '@src/session/dto/session.response';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { DecisionService } from './decision.service';

class PinDecisionDto extends createZodDto(
	z.object({
		content: z.string().trim().min(1).max(DecisionLimits.CONTENT_MAX),
	}),
) {}

@ApiTags('Decisions')
@ApiBearerAuth('access-token')
@Controller('sessions/:id/decisions')
export class DecisionsController {
	constructor(private readonly decisions: DecisionService) {}

	/** Pin something the team agreed on. The agent follows it from its next step. Editors and Owner. */
	@Post()
	@RequireSessionAction('pinDecision')
	@ApiOperation({ summary: 'Pin a decision' })
	@ZodResponse({ status: 201, type: DecisionDto })
	pin(
		@Param('id') _id: string,
		@CurrentMembership() membership: SessionMember,
		@Body() body: PinDecisionDto,
	): Promise<DecisionDto> {
		return this.decisions.pinByHand(membership, body.content);
	}

	@Delete(':decisionId')
	@HttpCode(204)
	@RequireSessionAction('pinDecision')
	@ApiOperation({ summary: 'Unpin a decision' })
	@ApiNoContentResponse({ description: 'Unpinned' })
	async unpin(
		@Param('id') _id: string,
		@Param('decisionId') decisionId: string,
		@CurrentMembership() membership: SessionMember,
	): Promise<void> {
		await this.decisions.unpin(membership, decisionId);
	}
}
