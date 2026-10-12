import { Body, Controller, Param, Post } from '@nestjs/common';
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
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { ConflictService } from './conflict.service';

class ResolveConflictDto extends createZodDto(
	z.object({
		resolution: z
			.string()
			.trim()
			.min(1)
			.max(1000)
			.describe('What the team goes with. Pinned as a decision.'),
	}),
) {}

class ConflictDto extends createZodDto(
	z.object({
		id: z.uuid(),
		summary: z.string(),
		resolution: z.string().max(1000).nullable(),
		resolvedById: z.uuid().nullable(),
		resolvedAt: z.iso.datetime().nullable(),
	}),
) {}

@ApiTags('Conflicts')
@ApiBearerAuth('access-token')
@Controller('sessions/:id/conflicts')
export class ConflictsController {
	constructor(private readonly conflicts: ConflictService) {}

	/** Settle a conflict. Owner only. Unblocks the step and pins the resolution. */
	@Post(':conflictId/resolve')
	@RequireSessionAction('resolveConflict')
	@ApiOperation({ summary: 'Resolve a conflict' })
	@ApiConflictResponse({ description: 'Already resolved' })
	@ZodResponse({ status: 201, type: ConflictDto })
	async resolve(
		@Param('id') _id: string,
		@Param('conflictId') conflictId: string,
		@CurrentMembership() membership: SessionMember,
		@Body() body: ResolveConflictDto,
	): Promise<ConflictDto> {
		const c = await this.conflicts.resolve(
			membership,
			conflictId,
			body.resolution,
		);
		return {
			id: c.id,
			summary: c.summary,
			resolution: c.resolution,
			resolvedById: c.resolvedById,
			resolvedAt: c.resolvedAt?.toISOString() ?? null,
		};
	}
}
