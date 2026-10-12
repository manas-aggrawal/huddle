import { Body, Controller, Get, Param, Patch, Request } from '@nestjs/common';
import {
	ApiBearerAuth,
	ApiForbiddenResponse,
	ApiOperation,
	ApiTags,
} from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { WorkspaceService } from './workspace.service';

class WorkspaceUsageDto extends createZodDto(
	z.object({
		workspaceId: z.uuid(),
		tokenAllowance: z.number().int(),
		tokensUsedThisPeriod: z.number().int(),
		periodStart: z.string(),
	}),
) {}

class SetAllowanceDto extends createZodDto(
	z.object({ tokenAllowance: z.number().int().positive().max(1_000_000_000) }),
) {}

@ApiTags('Workspaces')
@ApiBearerAuth('access-token')
@Controller('workspaces/:id')
export class WorkspaceController {
	constructor(private readonly workspaces: WorkspaceService) {}

	/** The shared token pool: allowance, used this period, and when the period started. */
	@Get('usage')
	@ApiOperation({ summary: 'Token usage of a workspace' })
	@ZodResponse({ status: 200, type: WorkspaceUsageDto })
	usage(@Request() req, @Param('id') id: string): Promise<WorkspaceUsageDto> {
		return this.workspaces.usage(req.user.id, id);
	}

	/** Workspace admins only. Raising it resumes sessions paused by an empty pool. */
	@Patch('allowance')
	@ApiOperation({ summary: 'Change the token allowance' })
	@ApiForbiddenResponse({ description: 'Not a workspace admin' })
	@ZodResponse({ status: 200, type: WorkspaceUsageDto })
	setAllowance(
		@Request() req,
		@Param('id') id: string,
		@Body() body: SetAllowanceDto,
	): Promise<WorkspaceUsageDto> {
		return this.workspaces.setAllowance(req.user.id, id, body.tokenAllowance);
	}
}
